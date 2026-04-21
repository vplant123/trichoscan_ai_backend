const { Worker } = require("bullmq");
const { redisConnection, reportQueue } = require("../queues/config");
const { DiagnosticSession } = require("../models");
const { runDSE } = require("../services/dse.service");
const { analyseAllScalpImages, generateClinicalNarrativeAnthropic } = require("../services/claude.service");
const { mapDSEToReport } = require("../utils/reportTransformer");

/**
 * TrichoScan AI — Analysis Worker (Converted to Sequelize/Postgres)
 */

const analysisWorker = new Worker(
  "analysis",
  async (job) => {
    const { sessionId } = job.data;
    console.log(`🔍 [AnalysisWorker] [${job.id}] Attempting to fetch session for key: ${sessionId}`);

    // Wait slightly to ensure DB consistency
    await new Promise(r => setTimeout(r, 800));

    // Try finding by Primary Key (id) first
    let session = await DiagnosticSession.findByPk(sessionId);
    
    // Fallback: Try finding by sessionId field
    if (!session) {
      console.log(`⚠️ [AnalysisWorker] [${job.id}] Not found by PK. Trying sessionId field...`);
      session = await DiagnosticSession.findOne({ where: { sessionId } });
    }

    if (!session) {
      console.error(`❌ [AnalysisWorker] [${job.id}] CRITICAL: Session ${sessionId} not found in DB.`);
      throw new Error(`DiagnosticSession ${sessionId} not found for job ${job.id}`);
    }

    const sessionData = session.get({ plain: true });
    console.log(`✅ [AnalysisWorker] [${job.id}] Session ${session.sessionId} FOUND. Starting pipeline...`);

    try {
      await session.transitionTo("ANALYSIS_IN_PROGRESS");

      // ── STAGE 1: DSE (REQUIRED) ───────────────────────────────────
      console.log(`[AnalysisWorker] [${job.id}] STAGE 1: Running DSE...`);
      const dseResult = runDSE(sessionData);

      const pipelineStatus = { ...sessionData.pipelineStatus };
      pipelineStatus.dse = "COMPLETE";

      await session.update({
        dseResult,
        pipelineStatus
      });

      // ── STAGE 2: VISION AI (CONDITIONAL) ──────────────────────────
      if (sessionData.UploadedImage.length >= 2 && !sessionData.skipPhotoAnalysis) {
        try {
          console.log(`[AnalysisWorker] [${job.id}] STAGE 2: Dispatching Claude Vision...`);
          const visionResult = await analyseAllScalpImages(sessionData.UploadedImage, dseResult, sessionData);

          pipelineStatus.vision = "COMPLETE";
          await session.update({
            visionAnalysis: visionResult.visionResult,
            visionAdjustedScores: visionResult.adjustedScores,
            compositeConfidence: visionResult.compositeConfidence,
            pipelineStatus
          });
        } catch (visionError) {
          console.error(`[AnalysisWorker] [${job.id}] ⚠️ Vision Failed:`, visionError.message);
          pipelineStatus.vision = "FAILED_DEGRADED_TO_DSE_ONLY";
          await session.update({ pipelineStatus });
        }
      } else {
        pipelineStatus.vision = "SKIPPED_INSUFFICIENT_IMAGES";
        const { computeCompositeConfidence } = require("../services/claude.service");
        const compositeConfidence = computeCompositeConfidence(dseResult, null);

        await session.update({
          pipelineStatus,
          skipPhotoAnalysis: true,
          compositeConfidence
        });
      }

      // ── STAGE 3: TREATMENT PLAN ──────────────────────────────────
      console.log(`[AnalysisWorker] [${job.id}] STAGE 3: Building Treatment Plan...`);
      const phase1 = [
        { name: "Clinical Stabilization", type: "therapy", duration: "Months 1-3", priority: 1, task: "Reduce acute shedding." },
        { name: "Inflammation Control", type: "topical", duration: "Months 1-3", priority: 1, task: "Apply prescribed serums nightly." }
      ];
      if (dseResult.urgencyFlag === "HIGH") {
        phase1.unshift({ name: "Dermatologist Consultation", type: "therapy", duration: "Immediate", priority: 0, task: "In-person clinical verification required." });
      }
      const phase2 = [
        { name: "Regrowth Induction", type: "therapy", duration: "Months 4-6", priority: 1, task: "Activate dormant follicles." },
        { name: "Nutritional Consolidation", type: "lifestyle", duration: "Months 4-6", priority: 2, task: "Optimize protein & mineral intake." }
      ];
      const phase3 = [
        { name: "Maintenance Protocol", type: "topical", duration: "Months 7-12", priority: 1, task: "Long-term follicular shielding." },
        { name: "Semi-Annual Review", type: "therapy", duration: "Month 12", priority: 2, task: "Progress audit." }
      ];

      pipelineStatus.treatment = "COMPLETE";
      await session.update({
        treatmentRecommendations: {
          priority: dseResult.urgencyFlag,
          recommendedTherapies: phase1.map(t => t.name)
        },
        pipelineStatus
      });

      // ── STAGE 4: CLINCAL NARRATIVE ───────────────────────────────
      console.log(`[AnalysisWorker] [${job.id}] STAGE 4: Generating Clinical Narrative...`);
      try {
        const currentSessionData = session.get({ plain: true });
        const mapperShell = mapDSEToReport({ ...currentSessionData, dseResult }, { withPhotoAnalysis: pipelineStatus.vision === "COMPLETE" });

        let refinedNarrative;
        if (pipelineStatus.vision === "COMPLETE") {
          refinedNarrative = await generateClinicalNarrativeAnthropic(
            mapperShell,
            dseResult,
            currentSessionData.answers
          );
        } else {
          refinedNarrative = mapperShell;
        }

        pipelineStatus.narrative = "COMPLETE";
        await session.update({
          clinicalNarrative: refinedNarrative,
          pipelineStatus
        });
      } catch (narrativeError) {
        console.warn(`[AnalysisWorker] [${job.id}] ⚠️ Narrative AI Failed: ${narrativeError.message}`);
        pipelineStatus.narrative = "FAILED_USING_DSE_SUMMARY";
        await session.update({
          clinicalNarrative: mapDSEToReport(session.get({ plain: true })),
          pipelineStatus
        });
      }

      await session.transitionTo("ANALYSIS_COMPLETE");

      console.log(`[AnalysisWorker] [${job.id}] ✅ Pipeline SUCCESS (Status: ANALYSIS_COMPLETE).`);

    } catch (error) {
      console.error(`[AnalysisWorker] [${job.id}] ❌ TERMINAL FAILURE:`, error.message);
      await session.update({ errorMessage: error.message });
      await session.transitionTo("ERROR");
      throw error;
    }
  },
  {
    connection: redisConnection,
    concurrency: 5,
    limiter: { max: 10, duration: 1000 }
  }
);

analysisWorker.on("ready", () => {
  console.log("⚡ [AnalysisWorker] READY and listening for jobs on 'analysis' queue.");
});

analysisWorker.on("active", (job) => {
  console.log(`🚀 [AnalysisWorker] Job ${job.id} is now ACTIVE`);
});
analysisWorker.on("failed", (job, err) => {
  console.error(`[AnalysisWorker] Job ${job.id} failed: ${err.message}`);
});

module.exports = analysisWorker;
