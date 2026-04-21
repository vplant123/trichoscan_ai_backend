const { Op } = require("sequelize");
const puppeteer = require("puppeteer");
const handlebars = require("handlebars");
const fs = require("fs");
const path = require("path");
const { DiagnosticSession, Lead } = require("../models");
const storageService = require("./storage.service");
const projectRoot = path.resolve(__dirname, "../../").replace(/\\/g, "/");

/**
 * TrichoScan AI — PDF Report Generator (Converted to Sequelize/Postgres)
 */

handlebars.registerHelper('gt', function (a, b) { return a > b; });
handlebars.registerHelper('lt', function (a, b) { return a < b; });
handlebars.registerHelper('eq', function (a, b) { return a === b; });
handlebars.registerHelper('ne', function (a, b) { return a !== b; });
handlebars.registerHelper('gte', function (a, b) { return a >= b; });
handlebars.registerHelper('lte', function (a, b) { return a <= b; });
handlebars.registerHelper('ifEquals', function (arg1, arg2, options) {
  return (arg1 == arg2) ? options.fn(this) : options.inverse(this);
});
handlebars.registerHelper('and', function () {
  const args = Array.prototype.slice.call(arguments, 0, -1);
  return args.every(Boolean);
});
handlebars.registerHelper('or', function () {
  const args = Array.prototype.slice.call(arguments, 0, -1);
  return args.some(Boolean);
});

async function generateReportPDF(sessionId) {
  let browser = null;
  try {
    const session = await DiagnosticSession.findOne({
      where: {
        [Op.or]: [
          { id: isValidUUID(sessionId) ? sessionId : null },
          { sessionId: isValidUUID(sessionId) ? sessionId : null }
        ].filter(condition => condition[Object.keys(condition)[0]] !== null)
      },
      include: [{ model: Lead, as: 'lead' }]
    });

    if (!session) {
      throw new Error(`[ReportGenerator] Session ${sessionId} not found.`);
    }

    const sessionData = session.get({ plain: true });

    const templatePath = path.join(__dirname, "../templates/report.hbs");
    if (!fs.existsSync(templatePath)) throw new Error(`Template not found at ${templatePath}`);

    const templateSource = fs.readFileSync(templatePath, "utf-8");
    const template = handlebars.compile(templateSource);

    const data = await prepareReportData(sessionData, `file:///${projectRoot}/`);
    data.baseUrl = `file:///${projectRoot}/`;

    const html = template(data);

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754 });

    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
    });

    return pdfBuffer;

  } catch (error) {
    console.error("[ReportGenerator] ❌ PDF generation error:", error.message);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

const { mapDSEToReport, mergeRefinements } = require("../utils/reportTransformer");

async function prepareReportData(session, pdfBaseUrl = null) {
  const mapped = mapDSEToReport(session, {
    fullReport: true,
    withPhotoAnalysis: session.skipPhotoAnalysis === false
  });

  let finalized = mapped;
  if (session.clinicalNarrative) {
    finalized = mergeRefinements(mapped, session.clinicalNarrative);
  }

  const photos = session.UploadedImage || [];
  const photoBase64 = { photoFront: null, photoCrown: null, photoLeft: null, photoRight: null };

  if (!session.skipPhotoAnalysis && photos.length > 0) {
    const keys = ["photoFront", "photoCrown", "photoLeft", "photoRight"];
    for (let i = 0; i < photos.length && i < 4; i++) {
      try {
        const buffer = await storageService.getFileBuffer(photos[i]);
        photoBase64[keys[i]] = `data:image/jpeg;base64,${buffer.toString("base64")}`;
      } catch (err) {
        console.warn(`[ReportGenerator] Failed to embed image ${i}: ${err.message}`);
      }
    }
  }

  if (!global._staticReportImageCache) {
    const cache = {};
    const staticFolder = path.join(__dirname, "../templates/report-image");
    if (fs.existsSync(staticFolder)) {
      const files = fs.readdirSync(staticFolder);
      files.forEach(file => {
        try {
          const filePath = path.join(staticFolder, file);
          const buffer = fs.readFileSync(filePath);
          const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
          const key = `static_${file.replace(/[-.]/g, "_")}`;
          cache[key] = `data:${mime};base64,${buffer.toString("base64")}`;
        } catch (err) {
          console.warn(`[ReportGenerator] Failed to cache static image ${file}: ${err.message}`);
        }
      });
    }
    global._staticReportImageCache = cache;
  }
  const staticImages = global._staticReportImageCache;

  const final = {
    ...finalized,
    baseUrl: pdfBaseUrl,
    ...photoBase64,
    ...staticImages,
    medicalReview: finalized.medicalReview || {
      doctorName: "Dr. Arvind Poswal",
      doctorQualification: "MBBS, Hair Transplant Surgeon",
      doctorTitle: "Medical Director, Hairsncare",
      experienceHeadline: "15+ Years Clinical Excellence",
      reviewBody: "Assessment based on clinical diagnostic markers and AI-assisted follicle analysis.",
      casesReviewed: "50,000+",
      yearsExperience: "15+"
    }
  };

  if (final.aiPhotoTiles?.items) {
    const pKeys = ["photoFront", "photoCrown", "photoLeft", "photoRight"];
    final.aiPhotoTiles.items.forEach((item, idx) => {
      if (idx < pKeys.length && photoBase64[pKeys[idx]]) {
        item.image = photoBase64[pKeys[idx]];
      }
    });
  }

  return final;
}

function isValidUUID(uuid) {
  if (typeof uuid !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

module.exports = {
  generateReportPDF,
  prepareReportData
};