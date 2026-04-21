const { Router } = require("express");
const {
    createSession,
    patchAnswers,
    completeQuestionnaire,
    uploadImage,
    triggerAnalysis,
    getReport,
    getStatus,
    captureLead,
    verifyOtp,
    resendOtp,
    getResult,
    downloadReport
} = require("../../controllers/session.controller");
const { upload, memoryUpload } = require("../../middlewares/multer.middleware");

const router = Router();

const { BRANCHING_RULES } = require("../../services/branching.service");

// ─── PUBLIC / AUTHENTICATED METADATA ──────────────────────────────────────────
router.route("/questions").get((req, res) => {
    try {
        const questionnaire = require("../../config/questionnaire_v1.json");

        // All questions activated by Clinical Branching Rules are mandatory (§1.4.5)
        // Reinforced: This ensures the UI treats all conditional paths as terminal requires.
        const mandatoryBranchIds = new Set();
        BRANCHING_RULES.forEach(rule => {
            rule.activates.forEach(qId => mandatoryBranchIds.add(qId));
        });

        // Augment the JSON response without modifying the source file
        const augmentedSections = (questionnaire.sections || []).map(section => ({
            ...section,
            questions: (section.questions || []).map(q => ({
                ...q,
                // Restore 'id' field for options if they are using 'value' (§Frontend Compatibility)
                options: (q.options || []).map(opt => ({
                    ...opt,
                    id: opt.id || opt.value
                })),
                // Redundant condition mapping for old/new frontend versions
                isConditional: q.isConditional || !!q.conditional || !!q.conditions,
                conditions: q.conditions || (q.conditional ? [q.conditional] : []),
                mandatory: q.mandatory || mandatoryBranchIds.has(q.id)
            }))
        }));

        res.status(200).json({
            success: true,
            data: {
                version: questionnaire.version,
                sections: augmentedSections
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Metadata fetch failed" });
    }
});

// ─── PUBLIC INITIALIZATION ──────────────────────────────────────────────────
router.route("/").post(createSession);

// ─── SESSION PIPELINE (Public Flow for Anonymous Users) ───────────────────────
router.route("/:sessionId/answers").patch(patchAnswers);

router.route("/:sessionId/questionnaire/complete").post(completeQuestionnaire);

router.route("/:sessionId/images/:photoId").post(
    memoryUpload.fields([
        { name: "image", maxCount: 1 },
        { name: "file", maxCount: 1 },
        { name: "iage", maxCount: 1 }
    ]),
    uploadImage
);

router.route("/:sessionId/trigger-analysis").post(triggerAnalysis);

router.route("/status/:sessionId").get(getStatus);

// ─── LEAD CAPTURE & REPORTING ───────────────────────────────────────────────
router.route("/capture-lead").post(captureLead); // Triggers PDF generation

router.route("/reports/:sessionId").get(getReport);

router.route("/:sessionId/verify-otp").post(verifyOtp);
router.route("/:sessionId/resend-otp").post(resendOtp);

// ─── FINAL DOSSIER & DOWNLOAD ───────────────────────────────────────────────
router.route("/:sessionId/result").get(getResult); // Requires OTP verification (§1.2)
router.route("/:sessionId/report").get(getReport); // Returns S3 download link
router.route("/:sessionId/download").get(downloadReport);

module.exports = router;
