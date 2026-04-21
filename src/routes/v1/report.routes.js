const express = require("express");
const {
    generateReport,
    getDSEResult,
    getReportStatus,
    getReportResult,
    uploadScalpImage,
    getQuestionnaire,
} = require("../../controllers/report.controller");

const router = express.Router();

const { memoryUpload: imageUpload } = require("../../middlewares/multer.middleware");

// ─── REPORT ROUTES ────────────────────────────────────────────────────────────

router.get("/questions", getQuestionnaire);

router.post(
    "/upload-image",
    imageUpload.fields([
        { name: "image", maxCount: 1 },
        { name: "file", maxCount: 1 },
        { name: "iage", maxCount: 1 }
    ]),
    uploadScalpImage
);

router.post("/generate", generateReport);

router.get("/dse", getDSEResult);

router.get("/status", getReportStatus);

router.get("/result", getReportResult);

module.exports = router;
