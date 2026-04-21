const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const { DiagnosticSession, Lead } = require("../models");
const { sequelize } = require("../config/database");
const { analysisQueue, reportQueue } = require("../queues/config");
const storageService = require("../services/storage.service");
const { getActiveQuestions } = require("../services/branching.service");
const { sendOTP, sendReportOTP } = require("../utils/fast2sms.utils.js");
const { decryptPII } = require("../utils/security");
const { prepareReportData } = require("../services/reportGenerator.service");



const createSession = asyncHandler(async (req, res) => {
    const session = await DiagnosticSession.create({
        status: "INIT"
    });
    return res.status(201).json(new ApiResponse(201, { sessionId: session.sessionId, status: "INIT" }, "Session created"));
});

const patchAnswers = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { answers } = req.body;

    const result = await sequelize.transaction(async (t) => {
        const session = await DiagnosticSession.findOne({
            where: { sessionId },
            lock: true,
            transaction: t
        });
        if (!session) throw new ApiError(404, "Session not found");

        // Lock questionnaire after completion (§1.4.5 Hardening)
        if (!["INIT", "QUESTIONNAIRE_IN_PROGRESS"].includes(session.status)) {
            throw new ApiError(403, "Questionnaire is already finalized for this session. Please start a new session.");
        }

        const now = new Date();
        const updatedAnswers = { ...(session.answers || {}) };

        answers.forEach(item => {
            let qId, val;

            if (item.questionId !== undefined) {
                qId = item.questionId;
                val = item.value;
            } else {
                const keys = Object.keys(item);
                if (keys.length > 0) {
                    qId = keys[0];
                    val = item[qId];
                }
            }

            if (qId) {
                updatedAnswers[qId] = { value: val, answeredAt: item.answeredAt || now };
            } else {
                console.warn(`[DiagnosticSession] Could not parse answer item:`, item);
            }
        });

        session.set('answers', updatedAnswers);
        session.changed('answers', true);
        session.checkCompletion();

        if (session.status === "INIT") {
            await session.transitionTo("QUESTIONNAIRE_IN_PROGRESS", { transaction: t });
        } else {
            await session.save({ transaction: t });
        }

        return { completionRate: session.completionRate, status: session.status };
    });

    return res.status(200).json(new ApiResponse(200, result, "Synced"));
});

const completeQuestionnaire = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const session = await DiagnosticSession.findOne({ where: { sessionId } });
    if (!session) throw new ApiError(404, "Session not found");

    if (!session.checkCompletion()) {
        throw new ApiError(403, `Questionnaire incomplete (${session.completionRate}%). 80% minimum required.`);
    }

    const answersObj = {};
    Object.entries(session.answers).forEach(([qId, entry]) => {
        answersObj[qId] = entry.value;
    });

    const activeQuestions = getActiveQuestions(answersObj);

    const missingBranches = [];
    activeQuestions.forEach(qId => {
        if (!session.answers[qId]) {
            missingBranches.push(qId);
        }
    });

    if (missingBranches.length > 0) {
        throw new ApiError(409, `Mandatory clinical branches missing: ${missingBranches.join(", ")}`, { missingBranches });
    }

    await session.transitionTo("QUESTIONNAIRE_COMPLETE");
    return res.status(200).json(new ApiResponse(200, { status: "QUESTIONNAIRE_COMPLETE" }, "Finalized and ready for analysis"));
});

const uploadImage = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const sessionCheck = await DiagnosticSession.findOne({ where: { sessionId } });
    if (!sessionCheck) throw new ApiError(404, "Session not found");

    if (!["QUESTIONNAIRE_COMPLETE", "PHOTOS_UPLOADED", "ANALYSIS_COMPLETE", "REPORT_COMPLETE"].includes(sessionCheck.status)) {
        throw new ApiError(403, "Image upload is only allowed after questionnaire completion and before starting analysis.");
    }

    const file = req.file || (req.files && (req.files.image?.[0] || req.files.file?.[0] || req.files.iage?.[0]));

    if (!file) {
        throw new ApiError(400, "Image file is required. Field names allowed: 'image' or 'file'.");
    }

    if ((sessionCheck.UploadedImage || []).length >= 4) {
        throw new ApiError(403, "Maximum of 4 images allowed per session.");
    }

    const savedImage = await storageService.saveImage(file.buffer, sessionId, file.originalname);

    const finalCount = await sequelize.transaction(async (t) => {
        const session = await DiagnosticSession.findOne({
            where: { sessionId },
            lock: true,
            transaction: t
        });
        if (!session) throw new ApiError(404, "Session (refresh) not found");

        const updatedImages = [...(session.UploadedImage || []), savedImage.url];
        session.set('UploadedImage', updatedImages);
        session.changed('UploadedImage', true);

        console.log(`[UploadImage] Session: ${sessionId}, Images now: ${updatedImages.length}`);

        if (updatedImages.length >= 2) {
            await session.transitionTo("PHOTOS_UPLOADED", { transaction: t });
        } else {
            await session.save({ transaction: t });
        }

        return updatedImages.length;
    });

    return res.status(201).json(new ApiResponse(201, { count: finalCount }, "Saved"));
});

const triggerAnalysis = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { skipPhotos = false } = req.body || {};

    const session = await DiagnosticSession.findOne({ where: { sessionId } });
    if (!session) throw new ApiError(404, "Session not found");

    console.log(`[TriggerAnalysis] Session: ${sessionId}, Images: ${session.UploadedImage?.length || 0}, Status: ${session.status}`);
    if (!skipPhotos && (!session.UploadedImage || session.UploadedImage.length < 2)) {
        throw new ApiError(403, "2 photos required or explicitly skip them.");
    }

    if (!["QUESTIONNAIRE_COMPLETE", "PHOTOS_UPLOADED", "ANALYSIS_COMPLETE", "REPORT_COMPLETE"].includes(session.status)) {
        throw new ApiError(403, `Cannot trigger analysis. Ensure questionnaire is completed (Current Status: ${session.status}).`);
    }

    session.skipPhotoAnalysis = !!skipPhotos;
    const pipelineStatus = { ...(session.pipelineStatus || {}) };
    if (skipPhotos) {
        pipelineStatus.vision = "SKIPPED_BY_USER";
    }
    session.set('pipelineStatus', pipelineStatus);
    session.changed('pipelineStatus', true);

    await session.transitionTo("ANALYSIS_QUEUED");

    return res.status(202).json(new ApiResponse(202, {
        status: "ANALYSIS_QUEUED",
        isFallback: skipPhotos
    }, skipPhotos ? "Analysis Prepared (DSE-Only). Proceed to lead capture." : "Analysis Prepared (Full Scan). Proceed to lead capture."));
});

const captureLead = asyncHandler(async (req, res) => {
    const { sessionId, name, email, phone, consentPrivacyPolicy, consentToContact } = req.body;
    if (!consentPrivacyPolicy || !consentToContact) throw new ApiError(400, "Consent required.");

    const session = await DiagnosticSession.findOne({ where: { sessionId } });
    if (!session) throw new ApiError(404, "Session not found");

    const ALLOWED_LEAD_STATES = ["PHOTOS_UPLOADED", "ANALYSIS_QUEUED", "ANALYSIS_COMPLETE", "REPORT_COMPLETE", "ERROR"];
    if (!ALLOWED_LEAD_STATES.includes(session.status)) {
        throw new ApiError(403, `Cannot capture lead at current status: ${session.status}`);
    }

    // Lead upsert in Sequelize
    let lead = await Lead.findOne({ where: { sessionId: session.id } });
    if (lead) {
        await lead.update({ name, email, phone, consent: true });
    } else {
        lead = await Lead.create({ sessionId: session.id, name, email, phone, consent: true });
    }

    session.leadId = lead.id;

    await session.transitionTo("LEAD_CAPTURED");

    try {
        const otpCode = await sendReportOTP(phone);
        session.verificationOtp = otpCode;
    } catch (otpErr) {
        console.warn(`[CaptureLead] OTP dispatch failed but lead saved:`, otpErr.message);
    }

    await session.transitionTo("LEAD_CAPTURED");

    return res.status(202).json(new ApiResponse(202, { status: session.status }, "Lead saved. Please verify OTP to start analysis."));
});

const getStatus = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const session = await DiagnosticSession.findOne({
        where: { sessionId },
        include: [{ model: Lead, as: 'lead' }]
    });
    if (!session) throw new ApiError(404, "Session not found");

    const markers = session.clinicalNarrative?.visualMarkers || {};

    const photos = (session.UploadedImage || []).map((url, index) => {
        const types = ["front", "crown", "left", "right"];
        const type = types[index] || "other";
        const cleanUrl = url.startsWith('/') ? url : `/${url}`;

        return {
            url: cleanUrl,
            type: type,
            marker: markers[type] || { top: 50, left: 50, label: "Analyzing Area" }
        };
    });

    const data = {
        status: session.status,
        sessionId: session.sessionId,
        isVerified: session.isVerified,
        reportUrl: session.reportUrl,
        photos: photos,
        createdAt: session.createdAt,
        retryCount: session.retryCount,
        message: session.errorMessage || "Processing diagnostic data..."
    };

    const ALLOWED_DOSSIER_STATES = ["ANALYSIS_COMPLETE", "LEAD_CAPTURED", "REPORT_QUEUED", "REPORT_IN_PROGRESS", "REPORT_COMPLETE"];
    if (ALLOWED_DOSSIER_STATES.includes(session.status)) {
        data.clinicalNarrative = session.clinicalNarrative;
        data.dseResult = session.dseResult;
        data.visionAnalysis = session.visionAnalysis;
        data.lead = session.lead;
    }

    data.answers = session.answers;

    return res.status(200).json(new ApiResponse(200, data, "Diagnostic status and full dossier retrieved."));
});

const getReport = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const session = await DiagnosticSession.findOne({ where: { sessionId } });
    if (!session) throw new ApiError(404, "Session not found");

    if (session.status !== "REPORT_COMPLETE") {
        throw new ApiError(403, "Report not yet generated. Please wait.");
    }

    if (!session.isVerified) {
        throw new ApiError(401, "OTP Verification required to access clinical report.");
    }

    const presignedReportUrl = await storageService.generatePresignedUrl(session.reportUrl);

    return res.status(200).json(new ApiResponse(200, {
        url: presignedReportUrl,
        isFallback: session.pipelineStatus.vision === "FAILED_DEGRADED_TO_DSE_ONLY",
        fallbackType: "DSE_ONLY"
    }, "Ready"));
});

const getResult = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const session = await DiagnosticSession.findOne({
        where: { sessionId },
        include: [{ model: Lead, as: 'lead' }]
    });
    if (!session) throw new ApiError(404, "Session not found");

    if (!session.isVerified) {
        throw new ApiError(401, "Please verify your identity via OTP to see your detailed results.");
    }

    const presignedImages = await Promise.all(
        (session.UploadedImage || []).map(async (url) => {
            return await storageService.generatePresignedUrl(url);
        })
    );

    const sessionData = session.get({ plain: true });
    sessionData.UploadedImage = presignedImages;

    const { mapDSEToReport, mergeRefinements } = require("../utils/reportTransformer");

    const mapperShell = mapDSEToReport(sessionData, {
        withPhotoAnalysis: !session.skipPhotoAnalysis
    });

    const aiData = session.clinicalNarrative || {};
    const transformedData = mergeRefinements(mapperShell, aiData);

    return res.status(200).json({
        statusCode: 200,
        success: true,
        message: "Report retrieved successfully.",
        data: transformedData
    });
});

const downloadReport = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const session = await DiagnosticSession.findOne({ where: { sessionId } });

    if (!session) {
        throw new ApiError(404, "Session not found.");
    }

    if (!session.isVerified) {
        throw new ApiError(401, "Please verify your session via OTP before downloading the report.");
    }

    const { generateReportPDF } = require("../services/reportGenerator.service");
    const pdfBuffer = await generateReportPDF(session.id);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=TrichoScan_Report_${sessionId.split('-').pop()}.pdf`);
    res.setHeader("Content-Length", pdfBuffer.length);

    return res.end(pdfBuffer);
});

const verifyOtp = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const { otp } = req.body;

    const session = await DiagnosticSession.findOne({ where: { sessionId } });
    if (!session) throw new ApiError(404, "Session not found");

    if (!session.verificationOtp) {
        throw new ApiError(400, "No OTP found for this session. Please capture lead first.");
    }

    if (session.verificationOtp !== otp) {
        throw new ApiError(401, "Invalid or Expired OTP code.");
    }

    session.isVerified = true;
    await session.save();

    console.log(`[VerifyOTP] ${sessionId} verified. Triggering AI Analysis pipeline...`);

    const job = await analysisQueue.add("process-ai", {
        sessionId: session.id,
        isFallback: session.skipPhotoAnalysis
    }, {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 }
    });

    console.log(`📡 [VerifyOTP] JOB QUEUED SUCCESSFULLY! ID: ${job.id}`);

    return res.status(200).json(new ApiResponse(200, {
        isVerified: true,
        status: "ANALYSIS_IN_PROGRESS",
        message: "Identity Verified. AI Analysis started."
    }, "Identity Verified. Analysis processing..."));
});

const resendOtp = asyncHandler(async (req, res) => {
    const { sessionId } = req.params;

    const session = await DiagnosticSession.findOne({
        where: { sessionId },
        include: [{ model: Lead, as: 'lead' }]
    });
    if (!session) throw new ApiError(404, "Session not found");

    const lead = session.lead;
    if (!lead || !lead.phone) {
        throw new ApiError(404, "Lead contact info not found. Capture lead first.");
    }

    let phone;
    try {
        phone = decryptPII(lead.phone);
    } catch (e) {
        phone = lead.phone;
    }

    console.log(`[ResendOTP] Dispatching new code for session ${sessionId} to ${phone}`);
    const otpNumber = await sendReportOTP(phone);

    session.verificationOtp = otpNumber;
    await session.save();

    return res.status(200).json(new ApiResponse(200, { sessionId }, "OTP resent successfully via registered service."));
});

module.exports = {
    createSession,
    patchAnswers,
    completeQuestionnaire,
    uploadImage,
    triggerAnalysis,
    captureLead,
    getStatus,
    getReport,
    verifyOtp,
    resendOtp,
    getResult,
    downloadReport
};
