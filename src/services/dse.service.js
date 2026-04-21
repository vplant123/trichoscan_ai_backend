/**
 * TrichoScan AI — DSE ENGINE v4.4 (Ultra-Hardened Clinical Engine)
 * 
 * FINAL REALIGNMENT: Mandatory 1-to-1 mapping with 54-Q Matrix Option Values.
 * ZERO-SMOOTHING POLICY: High-intensity symptoms result in high-intensity penalties.
 */

const CONDITION_NAMES = {
  AGA: "Androgenetic Alopecia",
  FAGA: "Female Pattern Hair Loss",
  TE: "Telogen Effluvium",
  AA: "Alopecia Areata",
  SD: "Seborrheic Dermatitis",
  PS: "Psoriasis",
  SA: "Scarring Alopecia",
  CA: "Chemical/Traction Alopecia",
  NB: "Nutritional Deficiency",
  HT: "Thyroid-Related Loss",
  POK: "Hormonal/PCOS-Related",
  HA: "Hereditary Risk (Pre-Clinical)"
};

const clamp = (val) => Math.max(10, Math.min(100, Math.round(val)));

function normalizeBuckets(buckets) {
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  if (total === 0) return buckets;
  const normalized = {};
  for (const key in buckets) {
    normalized[key] = +( (buckets[key] / total) * 100 ).toFixed(2);
  }
  return normalized;
}

// 🧪 1. ROOT CAUSE ENGINE (CRITICAL FIX: TE & NB SENSITIVITY)
function computeRootCauses(a) {
  const buckets = { AGA: 0, TE: 0, NB: 0, HT: 0, SD: 0, CA: 0 };

  // AGA
  if (["both", "paternal", "maternal"].includes(a.Q_S03_001)) buckets.AGA += a.Q_S03_001 === "both" ? 50 : 35;
  if (["frontal", "temples", "crown", "temples_crown"].includes(a.Q_S02_004)) buckets.AGA += 30;
  if (a.Q_S02_002 === "gradual") buckets.AGA += 25;
  if (["moderate", "significant"].includes(a.Q_23)) buckets.AGA += 30;

  // TE (Sudden/Stress/Illness) — Primary triggers
  const isSudden = a.Q_S02_002 === "sudden" || a.Q_40 === "acute";
  if (isSudden) buckets.TE += 65; // Dominant trigger
  if (["high", "extreme"].includes(a.Q_S05_001)) buckets.TE += a.Q_S05_001 === "extreme" ? 70 : 45;
  const meds = Array.isArray(a.Q_S04_005) ? a.Q_S04_005 : [a.Q_S04_005];
  if (meds.some(m => ["covid", "fever", "surgery"].includes(m))) buckets.TE += 75;
  if (["postpartum_lt_6", "postpartum_6_12"].includes(a.Q_S10_001)) buckets.TE += 85; // Boosted from 60
  if (["moderate", "significant", "crash_diet"].includes(a.Q_S10_004)) buckets.TE += a.Q_S10_004 === "crash_diet" ? 95 : 65; // Boosted

  // NB (Nutrition)
  if (["poor", "very_poor"].includes(a.Q_S05_003)) buckets.NB += a.Q_S05_003 === "very_poor" ? 60 : 40;
  if (["low", "very_low"].includes(a.Q_S05_007)) buckets.NB += a.Q_S05_007 === "very_low" ? 55 : 35;

  // HT (Hormonal/PCOS)
  if (["yes_medicated", "suspected"].includes(a.Q_S04_001)) buckets.HT += 50;
  if (a.Q_S04_009 === "yes") buckets.HT += 40;
  if (["irregular", "absent", "perimenopause", "postmenopause"].includes(a.Q_S10_002)) buckets.HT += (a.Q_S10_002 === "absent" ? 45 : 30);
  if (["stopped_lt_6", "recently_switched"].includes(a.Q_S10_003)) buckets.HT += 35;
  if (["multiple", "confirmed", "acne_hirsutism"].includes(a.Q_S10_005)) buckets.HT += a.Q_S10_005 === "confirmed" ? 60 : 40;

  // SD (Scalp Inflammation)
  if (["oily", "very_oily"].includes(a.Q_S07_002)) buckets.SD += 30;
  if (["moderate", "severe", "constant"].includes(a.Q_S07_001)) buckets.SD += 40;
  if (["moderate", "severe"].includes(a.Q_S07_003)) buckets.SD += 45;

  return normalizeBuckets(buckets);
}

// 📊 2. CLINICAL DIMENSIONS (CRITICAL FIX: SCALP & DENSITY PENALTIES)
function computeDensity(a) {
  let score = 100;
  const areaMap = { frontal: 15, temples: 10, crown: 15, temples_crown: 30, diffuse: 15 };
  score -= (areaMap[a.Q_S02_004] || 0);

  const sevMap = { mild: 5, moderate: 15, severe: 30, advanced: 50 };
  score -= (sevMap[a.Q_13] || 0);

  const visMap = { bright_light: 10, moderate: 20, significant: 40, transparent: 60 };
  score -= (visMap[a.Q_18] || 0);

  // Regional Check (Only penalize if not already heavily hit by visibility)
  if (score > 60) {
    if (["moderate", "severe"].includes(a.Q_19)) score -= 10;
    if (["moderate", "severe"].includes(a.Q_20)) score -= 10;
    if (["moderate", "severe"].includes(a.Q_21)) score -= 10;
  }

  return clamp(score);
}

function computeStrength(a) {
  let score = 100;
  const minMap = { slight: 15, moderate: 35, significant: 55 };
  score -= (minMap[a.Q_23] || 0);

  if (["frequently", "easily", "constant"].includes(a.Q_24)) score -= 30;
  if (["rough", "damaged"].includes(a.Q_26)) score -= (a.Q_26 === "damaged" ? 35 : 15);
  
  return clamp(score);
}

function computeScalp(a) {
  let score = 100;
  const oilMap = { oily: 15, very_oily: 30, dry: 10, very_dry: 25 };
  score -= (oilMap[a.Q_S07_002] || 0);

  const itchMap = { mild: 5, moderate: 15, severe: 35, constant: 50 };
  score -= (itchMap[a.Q_S07_001] || 0);

  const flakeMap = { mild: 5, moderate: 15, severe: 35 };
  score -= (flakeMap[a.Q_S07_003] || 0);

  const redMap = { mild: 5, moderate: 15, significant: 30 };
  score -= (redMap[a.Q_S07_004] || 0);

  return clamp(score);
}

function computeFall(a) {
  const fallMap = { lt_50: 98, "50_100": 85, "100_150": 65, "150_200": 45, gt_200: 20 };
  let base = fallMap[a.Q_S02_003] || (a.Q_37 === "much_more" ? 50 : 90);
  if (a.Q_S10_004 === "crash_diet") base -= 30;
  return clamp(base);
}

function computeLifestyle(a) {
  let score = 100;
  const stressMap = { minimal: 0, low: 5, moderate: 15, high: 30, extreme: 60 };
  score -= (stressMap[a.Q_S05_001] || 0);

  const dietMap = { excellent: -10, good: 0, average: 10, poor: 30, very_poor: 50 };
  score -= (dietMap[a.Q_S05_003] || 0);
  
  const proteinMap = { high: -10, adequate: 0, low: 20, very_low: 40 };
  score -= (proteinMap[a.Q_S05_007] || 0);

  if (["regular", "heavy"].includes(a.Q_S05_004)) score -= 25; // Smoking
  if (["regular", "heavy"].includes(a.Q_S05_005)) score -= 20; // Alcohol

  return clamp(score);
}

function computeRecovery(a) {
  let score = 100;
  const durMap = { lt_3_months: 0, "3_6_months": 15, "6_12_months": 25, "1_2_years": 40, gt_5_years: 70 };
  score -= (durMap[a.Q_S02_001] || 15);

  // Scalp & Nutrition Modifiers (Heavy)
  const scalpScore = computeScalp(a);
  const lifestyleScore = computeLifestyle(a);
  
  if (scalpScore < 50) score -= 15; // Only minor hit for scalp
  if (lifestyleScore < 40) score -= 15;
  
  // TE / Postpartum Bonus (Highly Reversible)
  if (["postpartum_lt_6", "postpartum_6_12", "pregnant"].includes(a.Q_S10_001)) score += 15;
  if (a.Q_S02_002 === "sudden" || a.Q_40 === "acute") score += 20;

  // AGA / Duration Penalties (Genuine follicle loss)
  if (["gt_5_years", "1_2_years"].includes(a.Q_S02_001)) score -= (a.Q_S02_001 === "gt_5_years" ? 40 : 20);
  if (["both", "paternal"].includes(a.Q_S03_001)) score -= 15;

  // Age Modifier (Higher recovery for youth)
  if (a.Q_S01_001 === "under_20") score += 10;

  return clamp(score);
}

const computeHHI = (s) => Math.round(s.density * 0.2 + s.fall * 0.2 + s.recovery * 0.2 + s.strength * 0.15 + s.scalp * 0.15 + s.lifestyle * 0.1);

function interpretQuestionnaireData(session) {
  const answersMap = {};
  if (session.answers) {
    if (typeof session.answers.get === "function") {
      session.answers.forEach((v, k) => { answersMap[k] = v?.value !== undefined ? v.value : v; });
    } else {
      Object.entries(session.answers).forEach(([k, v]) => { answersMap[k] = v?.value !== undefined ? v.value : v; });
    }
  }
  return answersMap;
}

function runDSE(session) {
  const a = interpretQuestionnaireData(session);
  const dims = {
    density: computeDensity(a),
    strength: computeStrength(a),
    scalp: computeScalp(a),
    fall: computeFall(a),
    lifestyle: computeLifestyle(a),
    recovery: computeRecovery(a)
  };

  const hhi = computeHHI(dims);
  const causeBuckets = computeRootCauses(a);
  const conditions = Object.entries(causeBuckets).map(([code, score]) => ({
    code: code === "TE_PI" ? "TE" : code,
    name: CONDITION_NAMES[code === "TE_PI" ? "TE" : code] || code,
    probabilityPct: Math.round(score),
    classification: score > 30 ? "PRIMARY_CONDITION" : score > 15 ? "SECONDARY_CONDITION" : "TRACE"
  })).sort((a, b) => b.probabilityPct - a.probabilityPct);

  return {
    hairHealthIndex: hhi,
    severityBand: hhi >= 75 ? "MILD" : hhi >= 45 ? "MODERATE" : "SEVERE",
    urgencyFlag: hhi < 40 || causeBuckets.SD > 55 || causeBuckets.TE > 60 ? "HIGH" : hhi < 60 ? "MEDIUM" : "LOW",
    primaryConditions: conditions.filter(c => c.classification === "PRIMARY_CONDITION").map(c => c.name),
    secondaryConditions: conditions.filter(c => c.classification === "SECONDARY_CONDITION").map(c => c.name),
    conditions,
    conditionScores: causeBuckets,
    dimensionScores: { ...dims, fallControl: dims.fall, scalpHealth: dims.scalp },
    scoringEngineVersion: "4.4-Ultra",
    dataCompletenessPct: 100,
    compositeFiringLog: ["HARDCODED_CLINICAL_LOGIC_V4.4"],
    staging: hhi < 50 ? "Stage: Moderate" : "Stage: Early",
    flags: hhi < 35 ? ["CRITICAL_HEALTH_WARNING"] : []
  };
}

module.exports = { runDSE, interpretQuestionnaireData, CONDITION_NAMES };
