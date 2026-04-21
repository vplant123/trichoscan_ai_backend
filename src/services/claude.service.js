/**
 * TrichoScan AI — Claude Service v12.0
 *
 * Two distinct responsibilities:
 *
 *   1. runVisionAnalysis()         — optional image-based clinical observations
 *      feeding back into the Score Adjustment Engine (§3.8). Deterministic
 *      JSON output only.
 *
 *   2. generateClinicalNarrativeAnthropic() — PURE TEXT FORMATTER. Receives
 *      an already-built report shell from reportTransformer.js and returns
 *      ONLY polished text fields. Cannot touch scores, structure, or
 *      clinical classification. The mapper is the source of truth.
 *
 * PRINCIPLE:  DSE → Transformer → Claude (text polish) → mergeRefinements()
 */

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const storageService = require("./storage.service");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const VISION_MODEL = "claude-3-haiku"; // Keep Sonnet for Medical Vision Accuracy
const REPORT_MODEL = "claude-3-haiku";    // Switch to Haiku for Text Polishing (3-5x Cheaper)
const MAX_TOKENS_VISION = 1000;
const MAX_TOKENS_REPORT = 1200;
const REQUEST_TIMEOUT_MS = 180000;


// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Robust JSON parser for AI outputs. Handles:
 *   • Direct JSON
 *   • Markdown-fenced JSON (```json ... ```)
 *   • Prose-prefixed JSON ("Here is the result: { ... }")
 *   • Truncated JSON (attempts bracket repair)
 */
function parseAIResponse(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    throw new Error("EMPTY_RESPONSE");
  }

  // Strip markdown fences
  let cleanText = rawText.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // Attempt 1: direct parse of cleaned text
  try {
    return JSON.parse(cleanText);
  } catch (_) {
    // continue
  }

  // Attempt 2: extract the outermost JSON object
  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("JSON_EXTRACT_FAILED: no JSON object found in response");
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (_) {
    // Attempt 3: repair common issues (trailing commas, unbalanced brackets)
    let repaired = jsonMatch[0]
      .replace(/,(\s*[}\]])/g, "$1") // trailing commas
      .trim();

    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    if (openBraces > closeBraces) repaired += "}".repeat(openBraces - closeBraces);

    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;
    if (openBrackets > closeBrackets) repaired += "]".repeat(openBrackets - closeBrackets);

    try {
      return JSON.parse(repaired);
    } catch (finalErr) {
      throw new Error(`JSON_PARSE_FAILED: ${finalErr.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: VISION ANALYSIS (optional — only if 3 photos uploaded)
// ═══════════════════════════════════════════════════════════════════════════

function prepareLocalImageSource(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  return {
    type: "base64",
    media_type: mediaTypes[ext] || "image/jpeg",
    data: fs.readFileSync(imagePath).toString("base64"),
  };
}

async function prepareRemoteImageSource(imageUrl) {
  try {
    const buffer = await storageService.getFileBuffer(imageUrl);

    const ext = path.extname(new URL(imageUrl).pathname).toLowerCase();
    const mediaTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
    };

    return {
      type: "base64",
      media_type: mediaTypes[ext] || "image/jpeg",
      data: buffer.toString("base64"),
    };
  } catch (error) {
    console.error(`[ClaudeService] Failed to fetch remote S3 image: ${imageUrl}`, error.message);
    throw new Error(`REMOTE_S3_IMAGE_FETCH_FAILED: ${error.message}`);
  }
}

function resolveLocalPath(imageUrl) {
  const cleanUrl = imageUrl.startsWith("/") ? imageUrl.slice(1) : imageUrl;
  return path.join(__dirname, "../../public", cleanUrl);
}

const VISION_SYSTEM_PROMPT = `You are a Board-Certified Clinical Trichologist analyzing scalp photographs to supplement a pre-computed DSE (Diagnostic Scoring Engine) result.

Your observations SUPPLEMENT but DO NOT OVERRIDE the DSE. You report what you see in the images; the scoring engine decides how to weight it.

Return ONLY a valid JSON object. No prose, no markdown.`;

function buildVisionUserPrompt(dseResult) {
  const primary = dseResult.conditions?.find(c => c.classification === "PRIMARY_CONDITION");
  return `=== DSE CONTEXT (FOR CALIBRATION ONLY) ===
Gender: ${dseResult.gender || "unspecified"}
Primary condition (from DSE): ${primary?.name || "Undetermined"} at ${primary?.probabilityPct || 0}%
HHI: ${dseResult.HHI || "unknown"}

IMPORTANT: Report what you OBSERVE in the 3 photographs. If your observations contradict the DSE, report your findings independently in the "indeterminate_findings" field.

=== PHOTOGRAPHS ===
Photo 1 = FRONTAL HAIRLINE VIEW
Photo 2 = VERTEX / CROWN VIEW
Photo 3 = CLOSE-UP MACRO SCALP VIEW

Return this EXACT JSON structure:
{
  "frontal_analysis": {
    "hairline_recession_degree": "none|minimal|mild|moderate|severe",
    "temple_involvement": true,
    "norwood_grade_frontal": null,
    "ludwig_grade_frontal": null,
    "visible_scalp_abnormalities": [],
    "image_quality": 7,
    "indeterminate_findings": null
  },
  "crown_analysis": {
    "thinning_pattern": "absent|localized|diffuse|vertex_specific|circumferential",
    "density_vs_peripheral": "normal|slightly_reduced|moderately_reduced|severely_reduced",
    "miniaturisation_detected": false,
    "norwood_grade_crown": null,
    "ludwig_grade_crown": null,
    "image_quality": 7,
    "indeterminate_findings": null
  },
  "macro_analysis": {
    "follicular_density_estimate": "normal|mildly_reduced|moderately_reduced|severely_reduced|indeterminate",
    "miniaturisation_detected": false,
    "scalp_redness": "none|mild|moderate|severe",
    "scaling": "none|mild|moderate|severe",
    "scaling_type": "none|dry_white|oily_yellow|mixed",
    "crust_present": false,
    "follicular_plugging": false,
    "scarring_signs": false,
    "image_quality": 7,
    "indeterminate_findings": null
  },
  "overall_assessment": {
    "final_norwood_grade": null,
    "final_ludwig_grade": null,
    "image_based_primary_observation": "string",
    "image_based_secondary_observations": [],
    "overall_confidence_score": 75,
    "image_quality_adequate": true,
    "low_quality_reason": null
  }
}

Return ONLY the JSON object.`;
}

function validateVisionSchema(parsed) {
  const required = ["frontal_analysis", "crown_analysis", "macro_analysis", "overall_assessment"];
  for (const k of required) {
    if (!parsed[k]) throw new Error(`VISION_SCHEMA_MISSING_${k.toUpperCase()}`);
  }
  // Coerce quality scores to numbers
  parsed.frontal_analysis.image_quality = Number(parsed.frontal_analysis.image_quality) || 5;
  parsed.crown_analysis.image_quality = Number(parsed.crown_analysis.image_quality) || 5;
  parsed.macro_analysis.image_quality = Number(parsed.macro_analysis.image_quality) || 5;
  return parsed;
}

function evaluateImageQuality(visionResult) {
  const scores = [
    visionResult.frontal_analysis.image_quality,
    visionResult.crown_analysis.image_quality,
    visionResult.macro_analysis.image_quality,
  ];
  const avgQuality = scores.reduce((a, b) => a + b, 0) / 3;
  const failed = scores.filter(s => s < 3).length;
  return { adequate: failed === 0, avgQuality, failedCount: failed };
}

/**
 * Score Adjustment Engine (PRD §3.8) — applies vision findings as
 * deltas to DSE scores. Respects confidence floor.
 */
function applyVisionScoreAdjustments(visionResult, dseResult, gender) {
  const scores = {};
  (dseResult.conditions || []).forEach(c => {
    scores[c.code] = c.probabilityPct;
  });

  const overallConf = visionResult.overall_assessment?.overall_confidence_score || 0;
  const log = [];

  // Confidence floor — below 40, no adjustments
  if (overallConf < 40) {
    return { adjustedScores: scores, adjustmentLog: [{ rule: "CONFIDENCE_FREEZE", reason: `confidence ${overallConf} < 40` }] };
  }

  const macro = visionResult.macro_analysis || {};
  const overall = visionResult.overall_assessment || {};

  // VA-01: Miniaturisation detected → boost AGA/FAGA
  if (macro.miniaturisation_detected) {
    const target = gender === "female" ? "FAGA" : "AGA";
    if (scores[target] !== undefined) {
      scores[target] = Math.min(95, scores[target] + 15);
      log.push({ rule: "VA-01", target, delta: 15 });
    }
  }

  // VA-02: Scarring signs → boost SA
  if (macro.scarring_signs) {
    scores.SA = Math.min(95, (scores.SA || 0) + 25);
    log.push({ rule: "VA-02", target: "SA", delta: 25 });
  }

  // VA-03: Severe scaling → boost SD
  if (macro.scaling === "severe") {
    scores.SD = Math.min(95, (scores.SD || 0) + 20);
    log.push({ rule: "VA-03", target: "SD", delta: 20 });
  }

  // VA-04: Norwood grade >= 3 for males → boost AGA
  if ((gender === "male" || gender === "unspecified") && overall.final_norwood_grade >= 3) {
    scores.AGA = Math.min(95, (scores.AGA || 0) + 10);
    log.push({ rule: "VA-04", target: "AGA", delta: 10 });
  }

  return { adjustedScores: scores, adjustmentLog: log };
}

/**
 * §3.9 Composite Confidence Score
 */
function computeCompositeConfidence(dseResult, visionResult) {
  const qConf = dseResult.dataCompletenessPct || 0;

  if (!visionResult) {
    const score = qConf;
    const band = score >= 85 ? "HIGH" : score >= 65 ? "MODERATE" : "LOW";
    return { score, band, displayLabel: `${band} Confidence (Questionnaire Only)` };
  }

  const qualityAvg =
    ((visionResult.frontal_analysis?.image_quality || 0) +
      (visionResult.crown_analysis?.image_quality || 0) +
      (visionResult.macro_analysis?.image_quality || 0)) / 30;

  const vConf = (visionResult.overall_assessment?.overall_confidence_score || 0) * qualityAvg;
  const composite = Math.round(qConf * 0.6 + vConf * 0.4);
  const band = composite >= 85 ? "HIGH" : composite >= 65 ? "MODERATE" : "LOW";
  return { score: composite, band, displayLabel: `${band} Confidence (AI Visual + Clinical)` };
}

async function runVisionAnalysis(imageRefs, dseResult, hairTest, useUrls = false) {
  const imageContentBlocks = [];
  for (const photoId of ["P01", "P02", "P03"]) {
    const ref = imageRefs[photoId];
    if (!ref) throw new Error(`MISSING_IMAGE_${photoId}`);

    let source;
    // Check if it's a remote URL (S3) or a local path
    if (ref.startsWith("http")) {
      source = await prepareRemoteImageSource(ref);
    } else {
      const abs = ref.startsWith("/uploads") ? resolveLocalPath(ref) : ref;
      if (!fs.existsSync(abs)) throw new Error(`IMAGE_NOT_FOUND: ${abs}`);
      source = prepareLocalImageSource(abs);
    }
    imageContentBlocks.push({ type: "image", source });
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const startTime = Date.now();

  const response = await Promise.race([
    anthropic.messages.create({
      model: VISION_MODEL,
      max_tokens: MAX_TOKENS_VISION,
      temperature: 0,
      system: [
        {
          type: "text",
          text: VISION_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" } // §Cost: Cache the instructions
        }
      ],
      messages: [
        {
          role: "user",
          content: [
            ...imageContentBlocks,
            { type: "text", text: buildVisionUserPrompt(dseResult) },
          ],
        },
      ],
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("VISION_TIMEOUT")), REQUEST_TIMEOUT_MS)),
  ]);

  const latencyMs = Date.now() - startTime;
  const rawText = response.content[0]?.text || "";
  const visionResult = validateVisionSchema(parseAIResponse(rawText));

  const quality = evaluateImageQuality(visionResult);
  if (quality.failedCount === 3) {
    throw new Error("VISION_QUALITY_FAILURE: all 3 photos below threshold");
  }

  const { adjustedScores, adjustmentLog } = applyVisionScoreAdjustments(
    visionResult,
    dseResult,
    dseResult.gender
  );
  const compositeConfidence = computeCompositeConfidence(dseResult, visionResult);

  console.log(
    `[ClaudeVision] ${latencyMs}ms | quality=${quality.avgQuality.toFixed(1)} | ` +
    `adjustments=[${adjustmentLog.map(a => a.rule).join(",")}] | ` +
    `confidence=${compositeConfidence.score}% (${compositeConfidence.band})`
  );

  return {
    status: "COMPLETE",
    visionResult,
    adjustedScores,
    adjustmentLog,
    compositeConfidence,
    quality,
    latencyMs,
  };
}

async function analyseAllScalpImages(imageUrls, dseResult, hairTest) {
  if (!imageUrls || imageUrls.length < 2) {
    throw new Error(`INSUFFICIENT_IMAGES: need 2, got ${imageUrls?.length || 0}`);
  }
  return runVisionAnalysis(
    { P01: imageUrls[0], P02: imageUrls[1], P03: imageUrls[2] },
    dseResult,
    hairTest,
    false
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: CLINICAL NARRATIVE REFINEMENT (TEXT ONLY)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strict system prompt: Claude is a text formatter, not a diagnostician.
 */
const NARRATIVE_REFINEMENT_SYSTEM_PROMPT = `
You are a strict text refinement engine for a clinical hair diagnostic report.
Your SOLE job is to improve the wording of text fields that have already been
deterministically generated by a Diagnostic Scoring Engine (DSE) and a Report
Transformer.

═══════════════════════════════════════════════════════════════════════════════
OPERATING LAWS — VIOLATION INVALIDATES THE OUTPUT
═══════════════════════════════════════════════════════════════════════════════

LAW 1 — DATA IMMUTABILITY
You MUST NOT alter, recompute, round, or substitute any of these:
  • HHI, severity, urgency, condition names, probabilityPct
  • score, progress, percent, dashArray, rank
  • tone, icon, tag, status, phase, monthRange, thumbClass
If you see these fields in the SHELL, they are there for context ONLY —
you do not output them.

LAW 2 — TEXT FIELDS ONLY
You may ONLY refine these field types:
  desc, note, summary, meaning, detail, action, scoreNote, blurb, subtitle,
  applicationNote, impact, how, summaryText, text,
  bullets[], steps[]
Return ONLY these text fields in your output, preserving the same
section keys and item order as the input SHELL.

LAW 3 — GROUNDED LANGUAGE
Every refinement must be grounded in the PATIENT_TRUTH block.
  • Reference the patient's real values (age, gender, diet, stress level)
  • Reference the DSE's real numbers (HHI, primary condition, probability)
  • NEVER invent conditions, medications, dosages, test values, or brand names
  • NEVER use phrases like "studies show", "commonly", "in many patients"

LAW 4 — DIETARY LOCK
If PATIENT_TRUTH.diet = vegan_strict:
  • NO eggs, dairy, fish, meat, poultry in any food recommendation
  • NO whey, casein, gelatin mentions
If diet = vegetarian:
  • NO fish, meat, poultry
  • Eggs and dairy OK

LAW 5 — CONTRAINDICATION SAFETY
If PATIENT_TRUTH.pregnant === true or postpartum === true:
  • NO Minoxidil, Finasteride, Spironolactone recommendations
If PATIENT_TRUTH.autoimmune === true:
  • NO Ashwagandha or immune-boosting adaptogens

LAW 6 — LENGTH CONSTRAINTS
  • summaryText / text:        80-150 words
  • assessment / hhiSection:    1-2 sentences
  • causalFactor / recoverySection: 1-2 sentences
  • desc / note:                1-2 sentences (max 30 words)
  • summary / meaning:          2-3 sentences (max 50 words)
  • detail / action:            1 sentence (max 20 words)
  • bullets / steps items:      1 sentence each

LAW 7 — OUTPUT DISCIPLINE
Return ONE valid JSON object containing ONLY the text fields you refined.
No markdown, no prose preamble, no code fences, no apologies.
Maintain the exact section keys and item ordering from the input SHELL.
`.trim();

/**
 * Builds a lean "shell" containing ONLY text fields, so we don't waste tokens
 * sending numbers/structure that Claude isn't allowed to touch.
 */
function extractTextOnlyShell(mapperReport) {
  const shell = {};

  if (mapperReport.header?.summaryText) {
    shell.header = { summaryText: mapperReport.header.summaryText };
  }
  if (mapperReport.executiveSummary?.text) {
    shell.executiveSummary = { text: mapperReport.executiveSummary.text };
  }
  if (mapperReport.clinicalSummary) {
    shell.clinicalSummary = {
      assessment: mapperReport.clinicalSummary.assessment,
      hhiSection: mapperReport.clinicalSummary.hhiSection,
      causalFactor: mapperReport.clinicalSummary.causalFactor,
      recoverySection: mapperReport.clinicalSummary.recoverySection
    };
  }

  const pickFields = (items, fields) =>
    items.map(item => {
      const out = {};
      fields.forEach(f => {
        if (item[f] !== undefined) out[f] = item[f];
      });
      return out;
    });

  const sectionMap = [
    ["recommendationRows", ["desc", "purpose"]],
    ["clinicalDimensions", ["note"]],
    ["deepMetricRows", ["scoreNote", "meaning", "blurb"]],
    ["regionalZones", ["note"]],
    ["rootCausePrimary", ["summary"]],
    ["additionalContributingFactors", ["summary"]],
    ["scalpRecoveryCards", ["note"]],
    ["treatmentRecommendationRows", ["desc", "duration"]],
    ["personalisedTreatmentPhases", ["subtitle", "bullets"]],
    ["lifestyleRiskFactors", ["note"]],
    ["nutritionalProtocolCards", ["desc", "foods"]],
    ["dailyMealPlanRows", ["detail"]],
    ["foodsHabitsToAvoid", ["detail"]],
    ["dailyRoutineItems", ["action", "note"]],
    ["stressReductionTechniques", ["desc", "impact", "how"]],
    ["cortisolReducingFoods", ["desc"]],
    ["activeRiskFactors", ["note"]],
    ["shaftScalpInsightCards", ["summary", "steps"]],
    ["aiAnalysisInsightRows", ["desc"]],
  ];

  for (const [sectionKey, fields] of sectionMap) {
    const section = mapperReport[sectionKey];
    if (section?.items && Array.isArray(section.items) && section.items.length > 0) {
      shell[sectionKey] = { items: pickFields(section.items, fields) };
    }
  }

  return shell;
}

/**
 * Builds a compact "patient truth" block for Claude to ground every
 * refinement against. Only carries semantic facts, not scores to protect.
 */
function extractPatientTruth(mapperReport, dseResult, rawAnswers) {
  const get = (qid) => {
    if (!rawAnswers) return null;
    let entry;
    if (typeof rawAnswers.get === "function") entry = rawAnswers.get(qid);
    else entry = rawAnswers[qid];
    if (entry === undefined || entry === null) return null;
    const v = entry?.value !== undefined ? entry.value : entry;
    return v;
  };

  const dietRaw = String(get("Q_S05_003") || "").toLowerCase();
  const pregnancyStatus = String(get("Q_S04_010") || "").toLowerCase();
  const autoimmune = String(get("Q_S04_003") || "").toLowerCase();

  return {
    identity: {
      gender: mapperReport.patient?.gender || dseResult.gender,
      ageDisplay: mapperReport.patient?.ageDisplay || "",
    },
    dse: {
      primaryCondition: mapperReport.clinicalClassification?.primaryCondition,
      probabilityPct: mapperReport.clinicalClassification?.probabilityPct,
      hhi: mapperReport.clinicalClassification?.hhi,
      severity: mapperReport.clinicalClassification?.severity,
      urgency: mapperReport.clinicalClassification?.urgency,
      firedRules: dseResult.flags || [],
    },
    lifestyleFacts: {
      diet: dietRaw.includes("vegan") ? "vegan_strict" :
        dietRaw.includes("non") ? "non_vegetarian" :
          dietRaw.includes("vegetarian") ? "vegetarian" : "non_vegetarian",
      stressLevel: get("Q_S05_001"),
      sleepHours: get("Q_S05_002"),
      proteinFrequency: get("Q_S05_007"),
    },
    contraindications: {
      pregnant: pregnancyStatus.includes("pregnant"),
      postpartum: pregnancyStatus.includes("postpartum"),
      autoimmune:
        autoimmune.includes("lupus") ||
        autoimmune.includes("alopecia") ||
        autoimmune.includes("psoriasis") ||
        autoimmune.includes("vitiligo"),
    },
    reportFlags: {
      withPhotoAnalysis: !!mapperReport.flags?.withPhotoAnalysis,
    },
  };
}

/**
 * Main entry: polish the text fields of a pre-built mapper report.
 *
 * Returns the AI's refinement JSON (text-only). The CALLER is responsible
 * for calling reportTransformer.mergeRefinements(mapperReport, refinement)
 * to produce the final merged response.
 *
 * If the refinement call fails, returns null — the caller should fall back
 * to the unrefined mapper shell, which is still fully valid.
 */
async function generateClinicalNarrativeAnthropic(mapperReport, dseResult, rawAnswers = {}) {
  if (!mapperReport || !dseResult) {
    throw new Error("generateClinicalNarrativeAnthropic: missing mapperReport or dseResult");
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const textShell = extractTextOnlyShell(mapperReport);
  const patientTruth = extractPatientTruth(mapperReport, dseResult, rawAnswers);

  const userMessage = `
### PATIENT_TRUTH (SOURCE OF FACTS — USE FOR GROUNDING ONLY)
${JSON.stringify(patientTruth, null, 2)}

### TEXT_SHELL (REFINE THESE TEXT FIELDS ONLY)
${JSON.stringify(textShell, null, 2)}

### TASK
Rewrite each text field in the TEXT_SHELL so that it:
  1. References the patient's actual data from PATIENT_TRUTH
  2. Uses clear, empathetic clinical language
  3. Respects the dietary, contraindication, and length laws in your instructions
  4. Is unique across items (no repetition, no generic filler)

Return ONLY a JSON object with the same section keys and item ordering as
TEXT_SHELL, containing the refined text fields. Do NOT include any fields
other than the text fields shown in the shell.
`.trim();

  const startTime = Date.now();
  let refinedData;

  try {
    const response = await Promise.race([
      anthropic.messages.create({
        model: REPORT_MODEL,
        max_tokens: MAX_TOKENS_REPORT,
        temperature: 0.2,
        system: [
          {
            type: "text",
            text: NARRATIVE_REFINEMENT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" } // §Cost: Cache the instructions
          }
        ],
        messages: [{ role: "user", content: userMessage }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("NARRATIVE_TIMEOUT")), REQUEST_TIMEOUT_MS)),
    ]);

    const latencyMs = Date.now() - startTime;
    const rawText = response.content[0]?.text || "";
    refinedData = parseAIResponse(rawText);

    const usage = response.usage || {};
    console.log(
      `[ClaudeNarrative] ${latencyMs}ms | tokens: in=${usage.input_tokens} out=${usage.output_tokens} | ` +
      `refined ${Object.keys(refinedData).length} sections`
    );

    return refinedData;
  } catch (err) {
    console.warn(
      `[ClaudeNarrative] Refinement failed after ${Date.now() - startTime}ms: ${err.message}. ` +
      `Returning null — caller should use unrefined mapper shell.`
    );
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════
module.exports = {
  // Vision pipeline
  runVisionAnalysis,
  analyseAllScalpImages,
  applyVisionScoreAdjustments,
  computeCompositeConfidence,
  evaluateImageQuality,

  // Narrative refinement pipeline
  generateClinicalNarrativeAnthropic,
  extractTextOnlyShell,
  extractPatientTruth,

  // Utilities
  parseAIResponse,
  parseVisionResponse: parseAIResponse, // legacy alias
};
