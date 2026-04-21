const { Op } = require("sequelize");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");

const { DiagnosticSession, Lead } = require("../models");

const { runDSE } = require("../services/dse.service");
const { analyseAllScalpImages, generateClinicalNarrativeAnthropic: generateClinicalNarrative } = require("../services/claude.service");
const { generateReportPDF } = require("../services/reportGenerator.service");
const storageService = require("../services/storage.service");
const leadsService = require("../services/leads.service");

const { mapDSEToReport, mergeRefinements } = require("../utils/reportTransformer");


const getReportResult = asyncHandler(async (req, res) => {
    try {
        const { sessionId } = req.query;

        if (!sessionId) {
            return res.status(400).json(new ApiResponse(400, null, "sessionId is required"));
        }

        const session = await DiagnosticSession.findOne({
            where: {
                [Op.or]: [
                    { id: isValidUUID(sessionId) ? sessionId : null },
                    { sessionId: isValidUUID(sessionId) ? sessionId : null }
                ].filter(condition => condition[Object.keys(condition)[0]] !== null)
            }
        });

        if (!session) {
            return res.status(404).json(new ApiResponse(404, null, "Clinical session not found"));
        }

        const sessionData = session.get({ plain: true });

        if (!sessionData.dseResult) {
            return res.status(404).json(new ApiResponse(404, null, "Diagnostic analysis not yet available for this session"));
        }

        const shell = mapDSEToReport(sessionData, { withPhotoAnalysis: true });
        const reportData = mergeRefinements(shell, sessionData.clinicalNarrative || {});

        return res.status(200).json(new ApiResponse(200, reportData, "Diagnostic results fetched successfully"));
    } catch (error) {
        console.error("[ReportController] getReportResult error:", error);
        return res.status(500).json(new ApiResponse(500, null, error.message || "Failed to fetch result"));
    }
});

const generateReport = asyncHandler(async (req, res) => {
    const { sessionId } = req.body;

    if (!sessionId) {
        return res.status(400).json(new ApiResponse(400, null, "sessionId is required"));
    }

    const session = await DiagnosticSession.findOne({
        where: {
            [Op.or]: [
                { id: isValidUUID(sessionId) ? sessionId : null },
                { sessionId: isValidUUID(sessionId) ? sessionId : null }
            ].filter(condition => condition[Object.keys(condition)[0]] !== null)
        }
    });

    if (!session) {
        return res.status(404).json(new ApiResponse(404, null, "Clinical session not found"));
    }

    const sessionData = session.get({ plain: true });
    const pipelineStatus = { dse: "PENDING", vision: "SKIPPED", narrative: "PENDING", pdf: "PENDING", storage: "PENDING" };

    let dseResult;
    try {
        dseResult = runDSE(sessionData);
        pipelineStatus.dse = "COMPLETE";
    } catch (dseError) {
        pipelineStatus.dse = "FAILED";
        return res.status(500).json(new ApiResponse(500, { pipelineStatus }, `Diagnostic scoring engine failed: ${dseError.message}`));
    }

    let visionAnalysis = { status: "SKIPPED", visionAnalysisAvailable: false, reason: "Vision AI not triggered" };
    let adjustedScores = null;
    let compositeConfidence = null;

    const uploadedImages = sessionData.UploadedImage || [];

    if (uploadedImages.length < 3) {
        pipelineStatus.vision = "SKIPPED_INSUFFICIENT_IMAGES";
        const { computeCompositeConfidence } = require("../services/claude.service");
        compositeConfidence = computeCompositeConfidence(dseResult, null);
    } else {
        try {
            const visionResponse = await analyseAllScalpImages(uploadedImages, dseResult, sessionData);
            visionAnalysis = visionResponse;
            adjustedScores = visionResponse.adjustedScores;
            compositeConfidence = visionResponse.compositeConfidence;
            pipelineStatus.vision = "COMPLETE";
        } catch (visionError) {
            visionAnalysis = { status: "FAILED", visionAnalysisAvailable: false, reason: `Vision API error: ${visionError.message}` };
            pipelineStatus.vision = "FAILED_DEGRADED_TO_DSE_ONLY";
        }
    }

    let narrativeResult;
    try {
        const shell = mapDSEToReport({ ...sessionData, dseResult }, { withPhotoAnalysis: pipelineStatus.vision === "COMPLETE" });
        if (pipelineStatus.vision === "COMPLETE") {
            narrativeResult = await generateClinicalNarrative(shell, dseResult, compositeConfidence);
        } else {
            narrativeResult = {};
        }
        pipelineStatus.narrative = "COMPLETE";
    } catch (narrativeError) {
        pipelineStatus.narrative = "FAILED_EMERGENCY_FALLBACK";
        narrativeResult = {
            executiveSummary: `Clinical assessment complete. Findings consistent with likely ${dseResult.primaryConditions[0] || "pattern hair loss"}.`,
            clinicalClassification: { primaryCondition: dseResult.primaryConditions[0], severity: dseResult.severityBand, staging: "Not applicable" },
            prognosis: "Assessment complete."
        };
    }

    const visionMode = pipelineStatus.vision === "COMPLETE" ? "FULL_AI" : "DSE_ONLY";
    await session.update({
        dseResult,
        visionAnalysis: visionAnalysis.visionResult || null,
        clinicalNarrative: narrativeResult,
        pipelineStatus,
        skipPhotoAnalysis: session.skipPhotoAnalysis || (uploadedImages.length < 3),
        visionAdjustedScores: adjustedScores,
        compositeConfidence
    });

    let pdfBuffer = null;
    try {
        pdfBuffer = await generateReportPDF(session.id);
        pipelineStatus.pdf = "COMPLETE";
    } catch (pdfError) {
        pipelineStatus.pdf = "FAILED_PDF_UNAVAILABLE";
    }

    let savedReport = null;
    if (pdfBuffer) {
        try {
            savedReport = await storageService.saveReport(pdfBuffer, session.id);
            pipelineStatus.storage = "COMPLETE";
            await session.update({
                reportUrl: savedReport.url,
                reportFileKey: savedReport.fileKey,
                reportGeneratedAt: new Date(),
            });
        } catch (storageError) {
            pipelineStatus.storage = "FAILED_NO_REPORT_URL";
        }
    }

    return res.status(200).json(new ApiResponse(200, {
        sessionId: session.sessionId,
        reportUrl: savedReport?.url || null,
        dseResult,
        visionAdjustedScores: adjustedScores,
        compositeConfidence,
        pipelineStatus,
        visionMode,
        generatedAt: new Date().toISOString()
    }, "Pipeline complete"));
});

const getDSEResult = asyncHandler(async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json(new ApiResponse(400, null, "sessionId is required"));

    const session = await DiagnosticSession.findOne({
        where: {
            [Op.or]: [
                { id: isValidUUID(sessionId) ? sessionId : null },
                { sessionId: isValidUUID(sessionId) ? sessionId : null }
            ].filter(condition => condition[Object.keys(condition)[0]] !== null)
        }
    });

    if (!session) return res.status(404).json(new ApiResponse(404, null, "Diagnostic session not found"));

    const dseResult = runDSE(session.get({ plain: true }));
    return res.status(200).json(new ApiResponse(200, dseResult, "DSE result computed successfully"));
});

const getReportStatus = asyncHandler(async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json(new ApiResponse(400, null, "sessionId is required"));

    const session = await DiagnosticSession.findOne({
        where: {
            [Op.or]: [
                { id: isValidUUID(sessionId) ? sessionId : null },
                { sessionId: isValidUUID(sessionId) ? sessionId : null }
            ].filter(condition => condition[Object.keys(condition)[0]] !== null)
        }
    });

    if (!session) return res.status(404).json(new ApiResponse(404, null, "Diagnostic session not found"));

    const sessionData = session.get({ plain: true });
    return res.status(200).json(new ApiResponse(200, {
        sessionId: sessionData.sessionId,
        status: sessionData.status,
        pipelineStatus: sessionData.pipelineStatus,
        reportUrl: sessionData.reportUrl,
        hhi: sessionData.dseResult?.hairHealthIndex || null,
        fullData: sessionData
    }, "Report status fetched successfully"));
});

const uploadScalpImage = asyncHandler(async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json(new ApiResponse(400, null, "sessionId is required"));

    const file = req.file || (req.files && (req.files.image?.[0] || req.files.file?.[0] || req.files.iage?.[0]));
    if (!file) return res.status(400).json(new ApiResponse(400, null, "No image file uploaded"));

    const session = await DiagnosticSession.findOne({
        where: {
            [Op.or]: [
                { id: isValidUUID(sessionId) ? sessionId : null },
                { sessionId: isValidUUID(sessionId) ? sessionId : null }
            ].filter(condition => condition[Object.keys(condition)[0]] !== null)
        }
    });

    if (!session) return res.status(404).json(new ApiResponse(404, null, "Diagnostic session not found"));

    const currentImages = session.UploadedImage || [];
    if (currentImages.length >= 3) return res.status(400).json(new ApiResponse(400, null, "Max 3 images allowed"));

    const savedImage = await storageService.saveImage(file.buffer, sessionId, file.originalname);
    const updatedImages = [...(session.UploadedImage || []), savedImage.url];
    session.set('UploadedImage', updatedImages);
    session.changed('UploadedImage', true);
    await session.save();

    return res.status(201).json(new ApiResponse(201, { imageUrl: savedImage.url, totalImages: currentImages.length + 1 }, "Image uploaded"));
});

const getQuestionnaire = asyncHandler(async (req, res) => {
    const scoringWeights = require("../config/scoringWeights.json");
    return res.status(200).json(new ApiResponse(200, scoringWeights, "Questionnaire fetched"));
});

function isValidUUID(uuid) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

module.exports = {
    generateReport,
    getDSEResult,
    getReportStatus,
    getReportResult,
    uploadScalpImage,
    getQuestionnaire,
};
