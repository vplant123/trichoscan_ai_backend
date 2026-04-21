/**
 * TrichoScan AI — Worker Registry
 * 
 * Implements §6 & §7 (Queue & Workers) of prd.md.
 * Ensures heavy tasks (AI, PDF) are processed asynchronously §12.
 */

const analysisWorker = require("./analysis.worker");
const reportWorker = require("./report.worker");

function startWorkers() {
  console.log("🚀 [WorkerRegistry] startWorkers() CALLED");
  console.log("🚀 TrichoScan AI — Background Workers Started.");
  console.log("- Analysis Worker (BullMQ: CONCURRENCY 2)");
  console.log("- Report Worker   (BullMQ: CONCURRENCY 3)");

  // Log global job events if needed for debugging (§9)
  analysisWorker.on("failed", (job, err) => {
    console.error(`[Worker] Analysis Job ${job.id} FAILED: ${err.message}`);
  });

  reportWorker.on("failed", (job, err) => {
    console.error(`[Worker] Report Job ${job.id} FAILED: ${err.message}`);
  });
}

module.exports = {
  startWorkers
};
