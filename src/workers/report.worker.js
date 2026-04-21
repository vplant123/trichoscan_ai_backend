const { Worker } = require("bullmq");
const { redisConnection } = require("../queues/config");
const { DiagnosticSession, Lead } = require("../models");
const { generateReportPDF } = require("../services/reportGenerator.service");
const storageService = require("../services/storage.service");

/**
 * Stage 7.2 — Report Worker (Converted to Sequelize/Postgres)
 */

const reportWorker = new Worker(
  "report",
  async (job) => {
    const { sessionId } = job.data;
    console.log(`[Worker] [report] GENERATING PDF: ${sessionId}`);

    // sessionId could be UUID or DB Primary Key
    const session = await DiagnosticSession.findOne({
      where: {
        [Op.or]: [
          { id: isValidUUID(sessionId) ? sessionId : null },
          { sessionId: isValidUUID(sessionId) ? sessionId : null }
        ].filter(condition => condition[Object.keys(condition)[0]] !== null)
      },
      include: [{ model: Lead, as: 'lead' }]
    });

    if (!session) throw new Error(`DiagnosticSession ${sessionId} not found`);

    try {
      console.log(`[Worker] Step 1: Generating PDF for ID: ${session.id}...`);

      const pdfBuffer = await generateReportPDF(session.id);

      console.log(`[Worker] Step 2: Uploading to storage...`);
      const storageResult = await storageService.saveReport(pdfBuffer, session.id);

      console.log(`[Worker] Step 3: Finalizing session data...`);
      await session.update({
        reportUrl: storageResult.url,
        reportFileKey: storageResult.fileKey,
        reportGeneratedAt: new Date()
      });

      await session.transitionTo("REPORT_COMPLETE");

      console.log(`[Worker] Report generation COMPLETE: ${storageResult.url}`);
      return { success: true, url: storageResult.url };
    } catch (err) {
      console.error(`[Worker] [report] ERROR:`, err.message);
      await session.update({ errorMessage: `PDF generation failed: ${err.message}` });
      await session.transitionTo("ERROR");
      throw err;
    }
  },
  { connection: redisConnection, concurrency: 3 }
);

function isValidUUID(uuid) {
  if (typeof uuid !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

const { Op } = require("sequelize");

module.exports = reportWorker;
