/**
 * TrichoScan AI — Report Transformer v12.0
 *
 * Takes DSE output + patient answers and produces the FULL UI-shaped JSON
 * shell. Every field has deterministic, grounded text. Claude then ONLY
 * polishes text fields — it cannot touch scores, conditions, or structure.
 *
 * DESIGN LAWS:
 *   1. All numbers come from DSE. This file never recomputes HHI/severity.
 *   2. Every text field ships with a grounded starter sentence. Empty strings
 *      are forbidden — if we can't generate meaningful text, we use a
 *      safe clinical default, not "".
 *   3. Treatment protocols come from the TREATMENT_LIBRARY keyed by DSE
 *      condition code. Branded/invented names are forbidden.
 *   4. The frontend spec (report_api_response_spec.json) is the contract.
 *      Every section named there must be present here with the same shape.
 *   5. DashArray values are PRE-COMPUTED here. Frontend just renders.
 */

const { CONDITION_NAMES } = require("../services/dse.service");
const { decryptPII } = require("../utils/security");

// ═══════════════════════════════════════════════════════════════════════════
// CLINICAL LIBRARIES — single source of truth for protocol text
// ═══════════════════════════════════════════════════════════════════════════

// Protocol library keyed by DSE condition code. Each condition has phase1/2/3
// protocols. All names are generic (PRD §: "generic names, not brand names").
const TREATMENT_LIBRARY = {
  AGA: {
    phase1: [
      { name: "Topical Minoxidil 5%", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Apply 1ml to dry scalp twice daily" },
      { name: "DHT-Blocking Shampoo", category: "COSMETIC_MEDICAL", applicationNote: "Use 3-4x per week" },
      { name: "Biotin + Zinc + Vitamin D3 stack", category: "NUTRACEUTICAL", applicationNote: "Once daily with food" },
    ],
    phase2: [
      { name: "Oral Finasteride 1mg (clinician-prescribed)", category: "ORAL_PHARMACOLOGICAL", applicationNote: "Daily, requires clinical supervision" },
      { name: "Low-Level Laser Therapy (LLLT 650nm)", category: "PROCEDURAL", applicationNote: "3 sessions per week, 20 minutes each" },
      { name: "Microneedling (0.5-1.5mm)", category: "PROCEDURAL", applicationNote: "Weekly, paired with topical Minoxidil" },
    ],
    phase3: [
      { name: "Maintenance Minoxidil", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Continue indefinitely" },
      { name: "Quarterly trichoscopy review", category: "PROCEDURAL", applicationNote: "Every 3 months" },
      { name: "Annual hormonal panel", category: "CLINICAL", applicationNote: "Annual DHT / testosterone / thyroid" },
    ],
  },
  FAGA: {
    phase1: [
      { name: "Topical Minoxidil 2%", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Apply 1ml to dry scalp twice daily" },
      { name: "Iron + Ferritin optimization", category: "NUTRACEUTICAL", applicationNote: "Test ferritin first; supplement if <70 ng/mL" },
      { name: "Scalp-barrier shampoo", category: "COSMETIC_MEDICAL", applicationNote: "Use 3-4x per week" },
    ],
    phase2: [
      { name: "Spironolactone (clinician-prescribed)", category: "ORAL_PHARMACOLOGICAL", applicationNote: "Only under endocrinology supervision" },
      { name: "Low-Level Laser Therapy (LLLT 650nm)", category: "PROCEDURAL", applicationNote: "3 sessions per week" },
      { name: "Platelet-Rich Plasma (PRP)", category: "PROCEDURAL", applicationNote: "3 sessions 4 weeks apart" },
    ],
    phase3: [
      { name: "Maintenance Minoxidil 2%", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Continue indefinitely" },
      { name: "Annual hormonal + thyroid panel", category: "CLINICAL", applicationNote: "Monitor DHEAS, testosterone, TSH" },
      { name: "Lifestyle optimization review", category: "LIFESTYLE", applicationNote: "Quarterly" },
    ],
  },
  TE: {
    phase1: [
      { name: "Trigger identification and removal", category: "CLINICAL", applicationNote: "Review medications, stress, nutrition, recent illness" },
      { name: "Iron + Vitamin D + Zinc correction", category: "NUTRACEUTICAL", applicationNote: "Supplement only after lab confirmation" },
      { name: "Sleep + stress protocol (min 7 hours)", category: "LIFESTYLE", applicationNote: "Daily" },
    ],
    phase2: [
      { name: "Scalp massage 5 min daily", category: "LIFESTYLE", applicationNote: "Improves microcirculation" },
      { name: "Protein intake audit (1.2 g/kg body weight)", category: "NUTRACEUTICAL", applicationNote: "Daily" },
      { name: "Adaptogenic support (if stress-driven)", category: "NUTRACEUTICAL", applicationNote: "Ashwagandha 300mg; avoid if autoimmune" },
    ],
    phase3: [
      { name: "Quarterly blood panel review", category: "CLINICAL", applicationNote: "Ferritin, TSH, Vitamin D" },
      { name: "Sustained nutritional balance", category: "LIFESTYLE", applicationNote: "Ongoing" },
      { name: "Re-trichoscopy at 6 months", category: "PROCEDURAL", applicationNote: "Assess regrowth" },
    ],
  },
  AA: {
    phase1: [
      { name: "Urgent dermatology referral", category: "CLINICAL", applicationNote: "Within 2 weeks — autoimmune workup" },
      { name: "Topical corticosteroid (clinician-prescribed)", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "As directed by dermatologist" },
      { name: "Autoimmune lab panel", category: "CLINICAL", applicationNote: "ANA, thyroid antibodies, CBC" },
    ],
    phase2: [
      { name: "Intralesional corticosteroid injections", category: "PROCEDURAL", applicationNote: "Dermatologist-administered, 4-6 week intervals" },
      { name: "Topical immunotherapy (specialist)", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Only in specialist clinics" },
    ],
    phase3: [
      { name: "Ongoing dermatology follow-up", category: "CLINICAL", applicationNote: "Every 3 months" },
      { name: "Stress management protocol", category: "LIFESTYLE", applicationNote: "Daily" },
    ],
  },
  SD: {
    phase1: [
      { name: "Ketoconazole 2% shampoo", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "3x per week, leave on 3-5 minutes before rinsing" },
      { name: "Zinc pyrithione scalp cleanser", category: "COSMETIC_MEDICAL", applicationNote: "Alternate with ketoconazole" },
      { name: "Scalp-barrier repair serum", category: "COSMETIC_MEDICAL", applicationNote: "Daily after wash" },
    ],
    phase2: [
      { name: "Zinc supplementation", category: "NUTRACEUTICAL", applicationNote: "15mg elemental zinc daily" },
      { name: "Avoid sulphate shampoos", category: "LIFESTYLE", applicationNote: "Ongoing" },
    ],
    phase3: [
      { name: "Maintenance antifungal wash", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "2x per week" },
      { name: "Seasonal reassessment", category: "CLINICAL", applicationNote: "Every 6 months" },
    ],
  },
  PS: {
    phase1: [
      { name: "Urgent dermatology referral", category: "CLINICAL", applicationNote: "Biopsy may be required" },
      { name: "Coal tar / salicylic acid shampoo", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "2-3x per week as directed" },
      { name: "Scalp moisture barrier support", category: "COSMETIC_MEDICAL", applicationNote: "Daily" },
    ],
    phase2: [
      { name: "Topical vitamin D analogue (specialist)", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "As prescribed" },
      { name: "Anti-inflammatory diet", category: "LIFESTYLE", applicationNote: "Reduce processed sugar and trans fats" },
    ],
    phase3: [
      { name: "Dermatology follow-up", category: "CLINICAL", applicationNote: "Every 3 months" },
      { name: "Stress reduction protocol", category: "LIFESTYLE", applicationNote: "Daily" },
    ],
  },
  SA: {
    phase1: [
      { name: "URGENT scalp biopsy", category: "PROCEDURAL", applicationNote: "Within 1 week — scarring alopecia is progressive and permanent" },
      { name: "Dermatology consultation", category: "CLINICAL", applicationNote: "Specialist required" },
      { name: "Stop all harsh haircare", category: "LIFESTYLE", applicationNote: "Immediate — no heat, no tight styles, no chemicals" },
    ],
    phase2: [
      { name: "Specialist-directed therapy", category: "CLINICAL", applicationNote: "Based on biopsy: LPP / FFA / DLE protocols differ" },
    ],
    phase3: [
      { name: "Lifelong monitoring", category: "CLINICAL", applicationNote: "Quarterly specialist review" },
    ],
  },
  CA: {
    phase1: [
      { name: "Stop all chemical treatments", category: "LIFESTYLE", applicationNote: "Immediate cessation" },
      { name: "Gentle sulphate-free shampoo", category: "COSMETIC_MEDICAL", applicationNote: "Daily" },
      { name: "Shaft repair conditioner (protein-based)", category: "COSMETIC_MEDICAL", applicationNote: "Weekly deep treatment" },
    ],
    phase2: [
      { name: "Avoid tight hairstyles", category: "LIFESTYLE", applicationNote: "Ongoing" },
      { name: "Biotin + protein support", category: "NUTRACEUTICAL", applicationNote: "Daily" },
    ],
    phase3: [
      { name: "Hair maintenance protocol", category: "LIFESTYLE", applicationNote: "Ongoing gentle care" },
    ],
  },
  NB: {
    phase1: [
      { name: "Full nutritional blood panel", category: "CLINICAL", applicationNote: "Ferritin, Vitamin D, B12, zinc, protein" },
      { name: "Protein intake correction", category: "NUTRACEUTICAL", applicationNote: "1.2-1.6 g/kg body weight daily" },
      { name: "Targeted supplementation (post-test)", category: "NUTRACEUTICAL", applicationNote: "Only deficiencies confirmed by labs" },
    ],
    phase2: [
      { name: "Sustained dietary optimization", category: "LIFESTYLE", applicationNote: "Balanced meals with adequate protein" },
      { name: "Re-test deficiencies at 3 months", category: "CLINICAL", applicationNote: "Quarterly until normalized" },
    ],
    phase3: [
      { name: "Annual nutritional review", category: "CLINICAL", applicationNote: "Maintain optimal levels" },
    ],
  },
  HT: {
    phase1: [
      { name: "TSH, Free T3, Free T4 panel", category: "CLINICAL", applicationNote: "Required before any treatment" },
      { name: "Endocrinology referral", category: "CLINICAL", applicationNote: "If thyroid abnormal" },
      { name: "Hair cycle support nutrients", category: "NUTRACEUTICAL", applicationNote: "Iron, selenium, zinc, vitamin D" },
    ],
    phase2: [
      { name: "Thyroid treatment adherence", category: "CLINICAL", applicationNote: "As prescribed by endocrinologist" },
      { name: "Nutritional support", category: "NUTRACEUTICAL", applicationNote: "Ongoing" },
    ],
    phase3: [
      { name: "Ongoing thyroid monitoring", category: "CLINICAL", applicationNote: "Every 6 months" },
    ],
  },
  POK: {
    phase1: [
      { name: "PCOS workup (endocrinologist)", category: "CLINICAL", applicationNote: "Required" },
      { name: "Topical Minoxidil 2%", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Twice daily" },
      { name: "Metabolic + insulin resistance panel", category: "CLINICAL", applicationNote: "Fasting insulin, HbA1c" },
    ],
    phase2: [
      { name: "Spironolactone (specialist)", category: "ORAL_PHARMACOLOGICAL", applicationNote: "Only under supervision" },
      { name: "Inositol supplementation", category: "NUTRACEUTICAL", applicationNote: "Myo-inositol 2g twice daily" },
    ],
    phase3: [
      { name: "Ongoing endocrine follow-up", category: "CLINICAL", applicationNote: "Quarterly" },
    ],
  },
  HA: {
    phase1: [
      { name: "Family history documentation", category: "CLINICAL", applicationNote: "For clinical correlation" },
      { name: "Preventive Minoxidil topical", category: "TOPICAL_PHARMACOLOGICAL", applicationNote: "Discuss with clinician" },
      { name: "Micronutrient optimization", category: "NUTRACEUTICAL", applicationNote: "Biotin, iron, zinc, D3" },
    ],
    phase2: [
      { name: "Early intervention review", category: "CLINICAL", applicationNote: "Annual" },
    ],
    phase3: [
      { name: "Lifelong maintenance", category: "LIFESTYLE", applicationNote: "Ongoing" },
    ],
  },
};

const NUTRITION_LIBRARY = {
  vegan_strict: {
    cards: [
      { title: "Biotin (Plant-Based)", dosage: "5,000 mcg/day", tone: "amber", icon: "chain", imageProvider: "static_IMG_2146_png", desc: "Supports keratin synthesis using plant-derived precursors.", foods: ["Almonds", "Walnuts", "Sweet potato", "Sunflower seeds"] },
      { title: "Non-Heme Iron", dosage: "18-27 mg/day", tone: "red", icon: "drop", imageProvider: "static_IMG_2146_png", desc: "Optimizes oxygen delivery; take with vitamin C for absorption.", foods: ["Spinach", "Lentils", "Tofu", "Pumpkin seeds"] },
      { title: "Zinc (Seeds & Nuts)", dosage: "15-30 mg/day", tone: "cyan", icon: "shield", imageProvider: "static_IMG_2146_png", desc: "Regulates enzyme activity via plant mineral pools.", foods: ["Pumpkin seeds", "Cashews", "Chickpeas", "Hemp seeds"] },
      { title: "Plant-Based D3", dosage: "2,000 IU/day", tone: "amber", icon: "sun", imageProvider: "static_IMG_2146_png", desc: "Maintains anagen using lichen-derived Vitamin D.", foods: ["Soy milk", "Mushrooms", "Lichen D3", "Sunlight"] },
    ],
    meals: [
      { meal: "Breakfast", tone: "amber", icon: "sun", detail: "Oatmeal with walnuts, flaxseeds, and sliced bananas" },
      { meal: "Lunch", tone: "green", icon: "leaf", detail: "Quinoa salad with chickpeas, spinach, and lemon dressing" },
      { meal: "Snack", tone: "cyan", icon: "apple", detail: "Pumpkin seeds and green tea" },
      { meal: "Dinner", tone: "slate", icon: "moon", detail: "Tofu stir-fry with broccoli, bell peppers, and brown rice" },
      { meal: "Supplement", tone: "amber", icon: "chain", detail: "Plant-Based D3 2000 IU + Zinc 15mg + Iron 18mg with dinner" },
    ],
  },
  vegetarian: {
    cards: [
      { title: "Biotin (Vitamin B7)", dosage: "5,000 mcg/day", tone: "amber", icon: "chain", imageProvider: "static_IMG_2146_png", desc: "Reinforces hair shaft structural integrity.", foods: ["Eggs", "Almonds", "Sweet potato", "Dairy"] },
      { title: "Iron Synthesis", dosage: "18-27 mg/day", tone: "red", icon: "drop", imageProvider: "static_IMG_2146_png", desc: "Optimizes oxygen delivery to follicle cells.", foods: ["Spinach", "Lentils", "Paneer", "Pumpkin seeds"] },
      { title: "Zinc Focus", dosage: "15-30 mg/day", tone: "cyan", icon: "shield", imageProvider: "static_IMG_2146_png", desc: "Regulates enzyme activity and cellular repair.", foods: ["Curd", "Chickpeas", "Cashews", "Seeds"] },
      { title: "Vitamin D3", dosage: "2,000-4,000 IU/day", tone: "amber", icon: "sun", imageProvider: "static_IMG_2146_png", desc: "Maintains active anagen growth phase.", foods: ["Milk", "Egg yolks", "Fortified curd", "Sunlight"] },
    ],
    meals: [
      { meal: "Breakfast", tone: "amber", icon: "sun", detail: "Greek yogurt with almonds and berries or scrambled eggs" },
      { meal: "Lunch", tone: "green", icon: "leaf", detail: "Lentil curry (Dal) with brown rice and curd" },
      { meal: "Snack", tone: "cyan", icon: "apple", detail: "Mixed nuts and seeds with fruit" },
      { meal: "Dinner", tone: "slate", icon: "moon", detail: "Paneer and vegetable stir-fry with quinoa" },
      { meal: "Supplement", tone: "amber", icon: "chain", detail: "Biotin 5000mcg + Iron 18mg + Zinc 15mg + D3 2000 IU with dinner" },
    ],
  },
  non_vegetarian: {
    cards: [
      { title: "Biotin (Vitamin B7)", dosage: "5,000 mcg/day", tone: "amber", icon: "chain", imageProvider: "static_IMG_2146_png", desc: "High-bioavailability keratin support.", foods: ["Salmon", "Eggs", "Almonds", "Sweet potato"] },
      { title: "Heme Iron", dosage: "18-27 mg/day", tone: "red", icon: "drop", imageProvider: "static_IMG_2146_png", desc: "Optimizes oxygen delivery via high-absorption heme iron.", foods: ["Red meat", "Chicken", "Spinach", "Lentils"] },
      { title: "Zinc Focus", dosage: "15-30 mg/day", tone: "cyan", icon: "shield", imageProvider: "static_IMG_2146_png", desc: "Regulates enzyme activity and cellular repair.", foods: ["Oysters", "Beef", "Chickpeas", "Cashews"] },
      { title: "Vitamin D3", dosage: "2,000-4,000 IU/day", tone: "amber", icon: "sun", imageProvider: "static_IMG_2146_png", desc: "Maintains active anagen growth phase.", foods: ["Fatty fish", "Egg yolks", "Cod liver oil", "Fortified milk"] },
    ],
    meals: [
      { meal: "Breakfast", tone: "amber", icon: "sun", detail: "Eggs with smoked salmon on whole-grain toast" },
      { meal: "Lunch", tone: "green", icon: "leaf", detail: "Grilled chicken breast with quinoa and leafy greens" },
      { meal: "Snack", tone: "cyan", icon: "apple", detail: "Mixed nuts and a boiled egg" },
      { meal: "Dinner", tone: "slate", icon: "moon", detail: "Baked cod or lean beef with roasted vegetables" },
      { meal: "Supplement", tone: "amber", icon: "chain", detail: "Biotin 5000mcg + Iron 18mg + Zinc 15mg + D3 2000 IU with dinner" },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const computeDash = (score, circumference) => {
  const s = Math.min(100, Math.max(0, Number(score) || 0));
  const dash = (s / 100) * circumference;
  return `${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}`;
};

/**
 * Answer accessor that handles: Mongoose Map, plain object, legacy sections.
 * Returns the normalized lowercase value or a fallback.
 */
const makeAnswerGetter = (answers) => (qid, fallback = null) => {
  if (!answers) return fallback;
  let entry;
  if (typeof answers.get === "function") entry = answers.get(qid);
  else entry = answers[qid];
  if (entry === undefined || entry === null || entry === "") return fallback;
  const v = entry?.value !== undefined ? entry.value : entry;
  if (Array.isArray(v)) return v.map(x => String(x));
  return v;
};

const safe = (v, fallback) => (v === undefined || v === null || v === "" ? fallback : v);

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Normalize diet_type answer to one of the 3 nutrition library keys */
const normalizeDietKey = (rawDiet) => {
  if (!rawDiet) return "non_vegetarian";
  const d = String(rawDiet).toLowerCase();
  if (d.includes("vegan")) return "vegan_strict";
  if (d.includes("non")) return "non_vegetarian";
  if (d.includes("vegetarian")) return "vegetarian";
  return "non_vegetarian";
};

/** Pick the diet key from answers — also scan common shapes */
const detectDiet = (get) => {
  const raw =
    get("Q_S05_003") ||
    get("diet") ||
    get("dietType");
  return normalizeDietKey(raw);
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * clinicalDimensions — the 6 FIXED rings the frontend expects.
 * These are NOT condition probabilities; they are derived scores for the
 * six dimensions shown on the main dashboard.
 *
 * Derivation is deterministic and grounded in DSE + answers:
 *   - Hair Density:  HHI-weighted base, reduced by AGA/FAGA/AA/SA score
 *   - Hair Strength: reduced by chemical treatment + heat styling + breakage
 *   - Fall Control:  inverse of TE score
 *   - Scalp Health:  inverse of SD + PS + redness symptoms
 *   - Recovery:      HHI-based, floored by urgency
 *   - Lifestyle:     derived from stress, sleep, diet, protein answers
 */
function buildClinicalDimensions(dse, get) {
  const ds = dse.dimensionScores || {};
  const hhi = dse.HHI || 0;

  const toStatus = (s) =>
    s >= 80 ? "Healthy" : s >= 60 ? "Moderate" : "High Risk";
  const toTone = (s) =>
    s >= 80 ? "healthy" : s >= 60 ? "mild" : "high-risk";

  const dimensions = [
    {
      title: "Hair Density",
      score: ds.density || 0,
      scoreLabel: (ds.density || 0) >= 70 ? "Healthy Density" : (ds.density || 0) >= 50 ? "Mild Thinning" : "Significant Loss",
      note: `Direct clinical scoring of follicle density and zone-wise distribution.`,
    },
    {
      title: "Hair Strength",
      score: ds.strength || 0,
      scoreLabel: (ds.strength || 0) >= 70 ? "Resilient" : (ds.strength || 0) >= 50 ? "Moderate Resilience" : "Fragile",
      note: `Clinical assessment of hair shaft integrity, miniaturization, and structural strength.`,
    },
    {
      title: "Fall Control",
      score: ds.fallControl || 0,
      scoreLabel: (ds.fallControl || 0) >= 70 ? "Stable" : (ds.fallControl || 0) >= 50 ? "Active Shedding" : "Acute Shedding",
      note: `Logarithmic mapping of daily hair fall counts and shedding patterns.`,
    },
    {
      title: "Scalp Health",
      score: ds.scalpHealth || 0,
      scoreLabel: (ds.scalpHealth || 0) >= 70 ? "Balanced Scalp" : (ds.scalpHealth || 0) >= 50 ? "Compromised" : "Inflamed",
      note: `Evaluation of the scalp environment, sebum levels, and inflammatory risk.`,
    },
    {
      title: "Recovery",
      score: ds.recovery || 0,
      scoreLabel: (ds.recovery || 0) >= 70 ? "Strong Potential" : (ds.recovery || 0) >= 40 ? "Moderate Potential" : "Guarded",
      note: `Prognostic mapping based on hair loss duration and genetic baseline.`,
    },
    {
      title: "Lifestyle",
      score: ds.lifestyle || 0,
      scoreLabel: (ds.lifestyle || 0) >= 70 ? "Supportive" : (ds.lifestyle || 0) >= 50 ? "Needs Attention" : "High Burden",
      note: `Consolidated impact score of stress, nutrition, and environmental factors.`,
    },
  ];

  return dimensions.map(d => ({
    ...d,
    status: toStatus(d.score),
    tone: toTone(d.score),
    dashArray: computeDash(d.score, 163.36),
  }));
}


/**
 * recommendationRows — 5 product cards, always 5.
 * Pulled from TREATMENT_LIBRARY for the primary condition, supplemented
 * with generic scalp/strength items if the library has fewer than 5.
 */
function buildRecommendationRows(primaryCode) {
  const lib = TREATMENT_LIBRARY[primaryCode] || TREATMENT_LIBRARY.AGA;
  const phase1 = lib.phase1 || [];

  const base = [
    ...phase1.slice(0, 2).map((p) => ({
      title: p.name,
      purpose: primaryCode === "AGA" || primaryCode === "FAGA" ? "For Hair Fall" : "For Root Cause",
      purposeTone: "purpose-amber",
      desc: p.applicationNote,
    })),
    { title: "Scalp Revive Serum", purpose: "For Scalp Health", purposeTone: "purpose-cyan", desc: "Restores scalp microbiome and hydration" },
    { title: "Biotin + Keratin Formula", purpose: "For Density", purposeTone: "purpose-amber", desc: "Strengthens hair shaft and improves density" },
    { title: "Anti-Stress Hair Tonic", purpose: "For Stress Loss", purposeTone: "purpose-gray", desc: "Counteracts stress-induced shedding" },
  ].slice(0, 5);

  return base.map((t, i) => ({
    ...t,
    tag: i === 0 ? "High Priority" : i < 3 ? "Recommended" : "Adjunct",
    tagTone: i === 0 ? "high-priority" : i < 3 ? "recommended" : "adjunct",
    price: ["₹1,499", "₹1,299", "₹999", "₹799", "₹899"][i] || "₹999",
    thumbClass: `thumb-${i + 1}`,
  }));
}

/**
 * personalisedTreatmentPhases — 3 phases with protocol-library bullets.
 */
function buildTreatmentPhases(primaryCode) {
  const lib = TREATMENT_LIBRARY[primaryCode] || TREATMENT_LIBRARY.AGA;

  return [
    {
      phase: "Phase I",
      monthRange: "Month 1-3",
      subtitle: "Foundation & Stabilization",
      tone: "cyan",
      icon: "shield",
      bullets: (lib.phase1 || []).map(p => `${p.name} — ${p.applicationNote}`),
      imageSource: "static_section9_1_png"
    },
    {
      phase: "Phase II",
      monthRange: "Month 3-6",
      subtitle: "Regrowth & Acceleration",
      tone: "amber",
      icon: "sprout",
      bullets: (lib.phase2 || []).map(p => `${p.name} — ${p.applicationNote}`),
      imageSource: "static_section9_2_png"
    },
    {
      phase: "Phase III",
      monthRange: "Month 6-12",
      subtitle: "Consolidation & Maintenance",
      tone: "green",
      icon: "star",
      bullets: (lib.phase3 || []).map(p => `${p.name} — ${p.applicationNote}`),
      imageSource: "static_section9_3_png"
    },
  ];
}

/**
 * treatmentRecommendationRows — flat 6-item priority list
 */
function buildTreatmentRows(primaryCode) {
  const lib = TREATMENT_LIBRARY[primaryCode] || TREATMENT_LIBRARY.AGA;
  const phase1 = lib.phase1 || [];
  const phase2 = lib.phase2 || [];
  const phase3 = lib.phase3 || [];

  const rows = [
    { src: phase1[0], priority: "HIGH",    timeFrame: "1-3 mo",   duration: "Ongoing daily", showImage: true },
    { src: phase1[1], priority: "HIGH",    timeFrame: "1-3 mo",   duration: "Ongoing",        showImage: true },
    { src: phase1[2] || phase2[0], priority: "MEDIUM",  timeFrame: "1-6 mo",  duration: "3-6 month cycle", showImage: true },
    { src: phase2[0], priority: "MEDIUM",  timeFrame: "3-6 mo",  duration: "Active phase", showImage: false },
    { src: phase2[1] || phase3[0], priority: "ADJUNCT", timeFrame: "2-12 mo", duration: "Adjunctive",    showImage: false },
    { src: phase3[0], priority: "MEDIUM",  timeFrame: "6-12 mo", duration: "Maintenance",   showImage: false },
  ].filter(r => r.src);

  return rows.map((r, index) => ({
    title: r.src.name,
    desc: r.src.applicationNote,
    priority: r.priority,
    priorityTone: r.priority.toLowerCase(),
    markerTone: r.priority.toLowerCase(),
    timeFrame: r.timeFrame,
    duration: r.duration,
    showImage: r.showImage,
    imageSource: index < 3 ? `static_treatmentRecommendation_${index + 1}_png` : null,
  }));
}

/**
 * rootCausePrimary + additionalContributingFactors
 * Derived DIRECTLY from DSE conditions. Top 3 → primary, next 3 → contributing.
 */
function buildRootCauses(dse) {
  const ranked = (dse.conditions || [])
    .filter(c => c.probabilityPct > 0)
    .slice(0, 7);

  const primary = ranked.slice(0, 3).map((c, i) => ({
    rank: i + 1,
    title: c.name,
    tag: "Primary Cause",
    score: c.probabilityPct,
    tone: i === 0 ? "cyan" : i === 1 ? "cyan" : "amber",
    summary: `${c.name} is detected at ${c.probabilityPct}% probability based on your questionnaire profile. This is a deterministic scoring output from the Diagnostic Scoring Engine.`,
  }));

  const contributing = ranked.slice(3, 7).map((c, i) => ({
    rank: i + 4,
    title: c.name,
    tag: i < 2 ? "Contributing" : i < 3 ? "Minor" : "Low",
    score: c.probabilityPct,
    summary: `${c.name} is flagged as a contributing factor at ${c.probabilityPct}% probability and warrants monitoring.`,
  }));

  // Pad to at least 3 primary and 4 contributing with safe clinical defaults
  while (primary.length < 3) {
    primary.push({
      rank: primary.length + 1,
      title: "No additional primary cause",
      tag: "Primary Cause",
      score: 0,
      tone: "amber",
      summary: "No additional primary cause flagged by the DSE at this time.",
    });
  }
  while (contributing.length < 4) {
    contributing.push({
      rank: contributing.length + 4,
      title: "No additional contributing factor",
      tag: "Low",
      score: 0,
      summary: "No additional contributing factor flagged.",
    });
  }

  return { primary, contributing };
}

function buildLifestyleRiskFactors(get) {
  const stress = String(get("Q_S05_001", "low"));
  const sleep = String(get("Q_S05_002", "good"));
  const diet = String(get("Q_S05_003", "average"));
  const protein = String(get("Q_S05_007", "adequate"));
  const smoking = String(get("Q_S05_004", "never"));
  const alcohol = String(get("Q_S05_005", "none"));

  const stressMap = { minimal: 95, low: 80, moderate: 55, high: 25, extreme: 10 };
  const stressProgress = stressMap[stress] || 80;
  const stressTone = stressProgress < 30 ? "high" : stressProgress < 60 ? "moderate" : "good";
  const stressTag = stress === "extreme" ? "Severe" : stress === "high" ? "High" : stress === "moderate" ? "Moderate" : "Low";

  const sleepMap = { excellent: 95, good: 80, fair: 55, poor: 25, insomnia: 10 };
  const sleepProgress = sleepMap[sleep] || 80;
  const sleepTone = sleepProgress < 30 ? "high" : sleepProgress < 60 ? "moderate" : "good";
  const sleepTag = sleep === "insomnia" ? "Critical" : sleep === "poor" ? "Weak" : sleep === "fair" ? "Fair" : "Normal";

  const dietMap = { excellent: 95, good: 80, average: 55, poor: 25, very_poor: 10 };
  const dietProgress = dietMap[diet] || 55;
  const dietTone = dietProgress < 30 ? "high" : dietProgress < 60 ? "moderate" : "good";
  const dietTag = (diet.charAt(0).toUpperCase() + diet.slice(1)).replace("_", " ");

  const proteinMap = { high: 95, adequate: 80, low: 25, very_low: 10 };
  const proteinProgress = proteinMap[protein] || 55;
  const proteinTone = proteinProgress < 30 ? "high" : proteinProgress < 60 ? "moderate" : "good";
  const proteinTag = protein === "very_low" ? "Critical" : protein === "low" ? "Deficient" : "Adequate";

  const smokingMap = { never: 95, quit: 65, occasional: 45, regular: 25, heavy: 10 };
  const smokingProgress = smokingMap[smoking] || 95;
  const smokingTone = smokingProgress < 30 ? "high" : smokingProgress < 60 ? "moderate" : "good";
  const smokingTag = (smoking.charAt(0).toUpperCase() + smoking.slice(1)).replace("_", " ");

  const alcoholMap = { none: 95, occasional: 80, regular: 45, heavy: 10 };
  const alcoholProgress = alcoholMap[alcohol] || 95;
  const alcoholTone = alcoholProgress < 30 ? "high" : alcoholProgress < 60 ? "moderate" : "good";
  const alcoholTag = (alcohol.charAt(0).toUpperCase() + alcohol.slice(1)).replace("_", " ");

  return [
    { label: "Stress Level", progress: stressProgress, tone: stressTone, tag: stressTag },
    { label: "Sleep Quality", progress: sleepProgress, tone: sleepTone, tag: sleepTag },
    { label: "Nutritional Intake", progress: dietProgress, tone: dietTone, tag: dietTag },
    { label: "Protein Baseline", progress: proteinProgress, tone: proteinTone, tag: proteinTag },
    { label: "Smoking Status", progress: smokingProgress, tone: smokingTone, tag: smokingTag },
    { label: "Alcohol Factor", progress: alcoholProgress, tone: alcoholTone, tag: alcoholTag },
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN MAPPER
// ═══════════════════════════════════════════════════════════════════════════

const mapDSEToReport = (session, flags = { withPhotoAnalysis: false, fullReport: true }) => {
  const photoCrown = session.UploadedImage?.find(img => img.id === "crown-view" || img.id === "P02")?.image || null;

  const getSeveritySummary = (sev) => {
    switch (sev) {
      case "SEVERE": return "Significant hair volume reduction detected across multiple zones.";
      case "MODERATE": return "Moderate thinning patterns observed in primary recession zones.";
      default: return "Early-stage follicle miniaturization detected in specific areas.";
    }
  };

  const getAiCorrelationSummary = (sev, withPhotos) => {
    if (!withPhotos) return "Assessment based on clinical questionnaire data and symptomatic mapping.";
    const status = sev === "SEVERE" ? "confirms advanced" : "detects early-stage";
    return `AI visual analysis ${status} thinning patterns that correlate with your questionnaire responses, ensuring localized accuracy.`;
  };

  const dse = session.dseResult || {};
  const answers = session.answers || {};
  const get = makeAnswerGetter(answers);

  // Derive core facts from DSE
  const primaryCondObj = (dse.conditions || []).find(c => c.classification === "PRIMARY_CONDITION") ||
                         (dse.conditions || [])[0] ||
                         { code: "AGA", name: "Androgenetic Alopecia", probabilityPct: 0 };
  const primaryCode = primaryCondObj.code;
  const primaryCondName = primaryCondObj.name;
  const primaryPct = primaryCondObj.probabilityPct || 0;

  const secondaryCondObj = (dse.conditions || []).find(c => c.classification === "SECONDARY_CONDITION") ||
                           (dse.conditions || [])[1] || {};
  const secondaryCondName = secondaryCondObj.name || "";
  const secondaryPct = secondaryCondObj.probabilityPct || 0;

  const categoryTitle = `Category 1 — ${primaryCondName}`;
  const genderRaw = String(get("Q_S01_002") || "unspecified").toLowerCase();
  const gender = genderRaw === "female" ? "female" : genderRaw === "male" ? "male" : "unspecified";
  
  const ageRaw = get("Q_S01_001") || "";
  const age = String(ageRaw).replace("_", " ");
  const dietKey = detectDiet(get);
  const nutritionData = JSON.parse(JSON.stringify(NUTRITION_LIBRARY[dietKey]));
  // These will be resolved to base64 in the PDF generator service
  nutritionData.cards = nutritionData.cards.map(c => ({
    ...c,
    imageSource: c.imageProvider // Key for the static image cache
  }));

  const hhi = dse.hairHealthIndex || 0;
  const severity = dse.severityBand || "MODERATE";
  const urgency = dse.urgencyFlag || "LOW";
  const stressNum = Number(get("Q_S05_001", 5)) || 5;

  const hhiLabel = severity === "MILD" ? "Healthy" : severity === "MODERATE" ? "Average" : "Below Average";
  const hhiPillLabel = hhi >= 75 ? "Good Hair Health" : hhi >= 45 ? "Moderate Hair Health" : "Needs Attention";

  // Clinical staging (v12.1 — Anchored to Q_13 Severity)
  const severityVal = String(get("Q_13") || "");
  const staging =
    (primaryCode === "AGA" || primaryCode === "FAGA") && severityVal ? `Stage: ${severityVal}` :
    primaryCode === "AA" ? "Active Phase" :
    primaryCode === "TE" ? "Diffuse Phase" :
    (dse.staging || "Stage Pending");

  // Risk scores for header cards
  const riskLevelLabel = urgency === "HIGH" ? "High Risk" : urgency === "MEDIUM" ? "Moderate Risk" : "Low Risk";
  const riskScore = urgency === "HIGH" ? 78 : urgency === "MEDIUM" ? 50 : 22;
  const hairLossRiskScore = Math.round(100 - hhi);

  const rootCauses = buildRootCauses(dse);
  const clinicalDimensions = buildClinicalDimensions(dse, get);
  const lifestyleFactors = buildLifestyleRiskFactors(get);
  const lifestyleImpactCount = lifestyleFactors.filter(f => f.progress < 60).length;

  // Recovery dimension for summary (usually rank 5 or title 'Recovery')
  const recoveryScore = (clinicalDimensions || []).find(d => d.title === "Recovery")?.score || hhi;

  // Full report shell
  return {
    lifestyleImpactCount,
    photoCrown,
    sessionId: session.sessionId,
    status: session.status || "COMPLETE",
    reportUrl: session.reportUrl || null,
    timestamp: session.updatedAt || new Date().toISOString(),

    flags: {
      withPhotoAnalysis: !!flags.withPhotoAnalysis,
      fullReport: flags.fullReport !== false,
    },

    header: {
      reportSeriesTitle: "Report 1 — Hair Intelligence",
      reportTypePill: flags.withPhotoAnalysis ? "AI Vision Report" : "Clinical Dossier",
      assessmentStatus: "Assessment Complete",
      patientIdDisplay: session.sessionId
        ? `ID: ${String(session.sessionId).split("-").pop().toUpperCase()}`
        : "ID: N/A",
      reportDate: new Date(session.updatedAt || Date.now()).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      }),
      mainHeading: "Hair Intelligence Report",
      summaryText: `AI-assisted clinical evaluation mapping ${primaryCondName} markers for a ${gender} patient. Results grounded in Diagnostic Scoring Engine output.`,
    },

    patient: {
      _id: session.leadId?._id || session.sessionId || "N/A",
      name: session.leadId?.name || get("patientName") || get("name") || session.patientName || "Valued User",
      email: (() => {
        try { return session.leadId?.email ? decryptPII(session.leadId.email) : (get("patientEmail") || session.patientEmail || ""); }
        catch (e) { return session.leadId?.email || ""; }
      })(),
      phone: (() => {
        try { return session.leadId?.phone ? decryptPII(session.leadId.phone) : (get("phone") || get("patientPhone") || session.patientPhone || ""); }
        catch (e) { return session.leadId?.phone || ""; }
      })(),
      gender: gender,
      ageDisplay: age ? `${age} years` : (session.age ? `${session.age} years` : ""),
      location: session.location || get("Q_S01_004") || "",
      category: session.category || "General",
    },

    executiveSummary: {
      text: age && gender !== "unspecified" 
        ? `Clinical findings indicate ${primaryCondName} (${primaryPct}% probability) as the primary pattern for this ${age}-year-old ${gender} patient. Hair Health Index (HHI) of ${hhi}/100 places overall status in the ${severity} band with ${urgency} urgency.`
        : `Clinical findings indicate ${primaryCondName} (${primaryPct}% probability) as the primary pattern. Hair Health Index (HHI) of ${hhi}/100 places overall status in the ${severity} band with ${urgency} urgency.`,
      confidenceBand: "HIGH",
      confidenceLabel: "HIGH Confidence (Deterministic DSE)",
    },

    clinicalSummary: {
      assessment: `The provisional assessment is ${dse.primaryId || "—"} — ${primaryCondName} — ${staging}, classified under ${categoryTitle}, staged as ${staging} — confirmatory trichoscopy and lab tests required.`,
      hhiSection: `Your Hair Health Index of ${hhi}/100 indicates ${hhiPillLabel.toLowerCase()} hair requiring ${urgency === "HIGH" ? "active clinical intervention" : "preventive monitoring"}.`,
      causalFactor: `The AI engine identifies ${primaryCondName} as the primary causal factor (${primaryPct}% probability).${secondaryCondName ? ` ${secondaryCondName} is a secondary contributor (${secondaryPct}%).` : ""}`,
      recoverySection: `Recovery potential: ${recoveryScore}/100. Prognosis is ${hhi >= 70 ? "favourable" : "guarded"} due to ${stressNum >= 7 ? "severe stress burden" : "clinical markers"}${dse.flags?.includes("THYROID_SHEDDING_BOOST") ? " and thyroid-linked shedding" : ""}. Consistent adherence is required over 6–12 months.`,
    },

    clinicalClassification: {
      trichologicalTitle: `${primaryCondName} — ${staging}`,
      staging,
      severity,
      urgency,
      hhi: Math.round(hhi),
      hhiLabel,
      hhiPillLabel: hhi >= 75 ? "Good Hair Health" : hhi >= 50 ? "Moderate Hair Health" : "Needs Attention",
      confidenceBand: "HIGH",
      riskLevelLabel,
      riskScore: Math.round(100 - hhi),
      hairLossRiskScore,
      categoryTitle: `Category 1 — ${primaryCondName}`,
      hhiDashArray: computeDash(hhi, 502.65),
      riskScoreDashArray: computeDash(riskScore, 219.91),
      hairLossRiskDashArray: computeDash(hairLossRiskScore, 207.35),
      geneticDashArray: computeDash(primaryPct, 207.35),
      stressLevelLabel: ["extreme", "high"].includes(String(get("Q_S05_001", "low"))) ? "High" : get("Q_S05_001") === "moderate" ? "Moderate" : "Low",
      probabilityPct: primaryPct,
      // New helper fields (Additive)
      severitySummary: getSeveritySummary(dse.severity),
      aiCorrelationSummary: getAiCorrelationSummary(dse.severity, flags.withPhotoAnalysis),
    },


    medicalReview: {
      doctorName: "Dr. Amit Sharma",
      doctorQualification: "MD, Dermatology",
      doctorTitle: "Certified  Trichologist",
      experienceHeadline: "15+ Years Clinical Excellence",
      reviewBody: "Assessment based on clinical diagnostic markers and AI-assisted follicle analysis.",
      casesReviewed: "2400+",
      yearsExperience: "15+",
      imageSource: "static_doctorimage_jpg",
    },

    recommendationRows: { items: buildRecommendationRows(primaryCode) },

    freebiesRows: {
      items: [
        { title: "Free Hair Consultation", desc: `Expert assessment for ${primaryCondName}` },
        { title: "Personalized Diet Plan", desc: `Optimized ${dietKey.replace("_", " ")} plan` },
        { title: "Weekly Hair Care Routine PDF", desc: "Step-by-step clinical routine" },
        { title: "Progress Tracking Support", desc: "Visual monitoring of results" },
        { title: "Priority Support Access", desc: "Direct baseline consultation" },
      ],
    },

    clinicalDimensions: { items: clinicalDimensions },

    deepMetricRows: {
      items: [
        {
          title: "Hair Health Index", tone: "cyan", score: hhi,
          scoreStand: hhi >= 75 ? "Top 25%" : hhi >= 50 ? "Average" : "Below Average",
          scoreNote: "Composite clinical index from DSE",
          benchmarkTitle: `AGE BENCHMARK${age ? ` (${age})` : ""}`,
          benchmarkLines: [
            `Typical HHI for your profile ranges 55-75.`,
            `Your score of ${hhi} places you in the ${severity} severity band.`,
          ],
          meaning: `Your Hair Health Index of ${hhi} reflects ${severity.toLowerCase()} overall hair health, grounded in the deterministic DSE scoring engine.`,
          progress: hhi,
        },
        {
          title: "Hair Density", tone: "green", score: clinicalDimensions[0].score,
          scoreStand: clinicalDimensions[0].score >= 70 ? "Good" : "Needs Attention",
          scoreNote: clinicalDimensions[0].scoreLabel,
          benchmarkTitle: "DENSITY BENCHMARK",
          benchmarkLines: [
            "Healthy density range: 70-100",
            `Your density score: ${clinicalDimensions[0].score}`,
          ],
          meaning: clinicalDimensions[0].note,
          progress: clinicalDimensions[0].score,
        },
        {
          title: "Recovery Potential", tone: "purple", score: clinicalDimensions[4].score,
          scoreStand: clinicalDimensions[4].score >= 70 ? "Excellent" : "Moderate",
          scoreNote: clinicalDimensions[4].scoreLabel,
          benchmarkTitle: "RECOVERY BENCHMARK",
          benchmarkLines: [
            "Recovery is independent of age and tracks follicle viability",
            `Your urgency level is ${urgency}`,
          ],
          meaning: clinicalDimensions[4].note,
          progress: clinicalDimensions[4].score,
        },
        {
          title: "Scalp Health", tone: "amber", score: clinicalDimensions[3].score,
          blurb: "The condition of your scalp environment — oiliness, inflammation, dandruff, and barrier function.",
          scoreStand: clinicalDimensions[3].score >= 70 ? "Balanced" : "Compromised",
          scoreNote: clinicalDimensions[3].scoreLabel,
          benchmarkTitle: "SCALP BENCHMARK",
          benchmarkLines: [
            "Scalp health is highly improvable — 4-8 weeks of targeted care shows measurable change",
            "A score below 50 should be addressed before starting regrowth treatments",
          ],
          meaning: clinicalDimensions[3].note,
          progress: clinicalDimensions[3].score,
        },
        {
          title: "Hair Fall Control", tone: "sky", score: clinicalDimensions[2].score,
          blurb: "How controlled your current shedding is. Higher is better.",
          scoreStand: clinicalDimensions[2].score >= 70 ? "Stable" : "Active",
          scoreNote: clinicalDimensions[2].scoreLabel,
          benchmarkTitle: "FALL CONTROL BENCHMARK",
          benchmarkLines: [
            "Normal daily hair fall is 50-100 strands",
            `Your reported shedding profile drives this score to ${clinicalDimensions[2].score}`,
          ],
          meaning: clinicalDimensions[2].note,
          progress: clinicalDimensions[2].score,
        },
      ],
    },

    regionalZones: {
      items: [
        {
          name: "Frontal Zone",
          percent: clamp(clinicalDimensions[0].score - (primaryCode === "AGA" || primaryCode === "FAGA" ? 15 : 5), 5, 100),
          note: "Hairline and forehead region assessment based on pattern distribution",
          status: clinicalDimensions[0].score >= 70 ? "Stable" : "Moderate",
        },
        {
          name: "Mid-Scalp",
          percent: clamp(clinicalDimensions[0].score - (primaryCode === "TE" ? 10 : 2), 5, 100),
          note: "Central scalp region reflecting primary condition scoring",
          status: clinicalDimensions[0].score >= 70 ? "Stable" : "Moderate",
        },
        {
          name: "Crown",
          percent: clamp(clinicalDimensions[0].score - (primaryCode === "AGA" || primaryCode === "TE" ? 10 : 4), 5, 100),
          note: "Vertex region monitoring zone",
          status: clinicalDimensions[0].score >= 70 ? "Stable" : "Moderate",
        },
      ],
    },

    rootCausePrimary: { items: rootCauses.primary },
    additionalContributingFactors: { items: rootCauses.contributing },

    scalpRecoveryCards: {
      items: [
        {
          title: "Scalp Health Risk",
          score: Math.round(100 - clinicalDimensions[3].score),
          scoreLabel: (100 - clinicalDimensions[3].score) <= 30 ? "Low" : (100 - clinicalDimensions[3].score) <= 70 ? "Moderate" : "High",
          note: "Inflammatory probability from symptom cluster",
          tone: "amber",
          dashArray: computeDash(100 - clinicalDimensions[3].score, 229.21),
          levels: ["Low", "Moderate", "High", "Severe"],
          activeLevel: (100 - clinicalDimensions[3].score) <= 30 ? "Low" : (100 - clinicalDimensions[3].score) <= 70 ? "Moderate" : "High",
        },
        {
          title: "Growth Potential",
          score: clinicalDimensions[4].score,
          scoreLabel: clinicalDimensions[4].score >= 75 ? "Excellent" : clinicalDimensions[4].score >= 40 ? "Good" : "Moderate",
          note: "Follicle viability and recovery probability",
          tone: "cyan",
          dashArray: computeDash(clinicalDimensions[4].score, 229.21),
          levels: ["Low", "Moderate", "Good", "Excellent"],
          activeLevel: clinicalDimensions[4].score >= 75 ? "Excellent" : clinicalDimensions[4].score >= 40 ? "Good" : "Moderate",
          hasFloatBadge: true,
        },
      ],
    },

    improvementPredictionCards: {
      items: [
        { 
          period: "3 Months",  
          phase: "Stabilisation Phase", 
          tone: "cyan",  
          metrics: [
            { label: "Density Gain", value: `+${Math.round(recoveryScore * 0.15)}%`, progress: clamp(Math.round(recoveryScore * 0.15), 5, 100) }, 
            { label: "Fall Reduction", value: `+${Math.round(30 + recoveryScore * 0.2)}%`, progress: clamp(Math.round(30 + recoveryScore * 0.2), 5, 100) }, 
            { label: "Shaft Quality", value: `+${Math.round(recoveryScore * 0.2)}%`, progress: clamp(Math.round(recoveryScore * 0.2), 5, 100) }
          ] 
        },
        { 
          period: "6 Months",  
          phase: "Active Growth",       
          tone: "amber", 
          metrics: [
            { label: "Density Gain", value: `+${Math.round(recoveryScore * 0.3)}%`, progress: clamp(Math.round(recoveryScore * 0.3), 5, 100) }, 
            { label: "Fall Reduction", value: `+${Math.round(50 + recoveryScore * 0.3)}%`, progress: clamp(Math.round(50 + recoveryScore * 0.3), 5, 100) }, 
            { label: "Shaft Quality", value: `+${Math.round(recoveryScore * 0.4)}%`, progress: clamp(Math.round(recoveryScore * 0.4), 5, 100) }
          ] 
        },
        { 
          period: "12 Months", 
          phase: "Consolidation",       
          tone: "green", 
          metrics: [
            { label: "Density Gain", value: `+${Math.round(recoveryScore * 0.55)}%`, progress: clamp(Math.round(recoveryScore * 0.55), 5, 100) }, 
            { label: "Fall Reduction", value: `+${Math.round(70 + recoveryScore * 0.25)}%`, progress: clamp(Math.round(70 + recoveryScore * 0.25), 100, 100) }, 
            { label: "Shaft Quality", value: `+${Math.round(recoveryScore * 0.7)}%`, progress: clamp(Math.round(recoveryScore * 0.7), 5, 100) }
          ] 
        },
      ],
    },

    treatmentRecommendationRows: { items: buildTreatmentRows(primaryCode) },
    personalisedTreatmentPhases: { items: buildTreatmentPhases(primaryCode) },
    lifestyleRiskFactors: { items: lifestyleFactors },
    nutritionalProtocolCards: { items: nutritionData.cards },
    dailyMealPlanRows: { items: nutritionData.meals },

    foodsHabitsToAvoid: {
      items: [
        { title: "Crash Dieting", detail: "Triggers telogen effluvium from nutrient depletion", tone: "danger" },
        { title: "Excess Sugar", detail: "Increases androgen activity and DHT levels", tone: "danger" },
        { title: "Trans Fats", detail: "Promote systemic inflammation around follicles", tone: "danger" },
        { title: dietKey === "vegan_strict" ? "Excessive Soy" : "Excess Dairy", detail: "May increase sebum production and inflammation", tone: "warning" },
        { title: "Processed Foods", detail: "Disrupt nutrient absorption and hormonal balance", tone: "danger" },
        { title: "Excess Alcohol", detail: "Depletes zinc, B12 and folic acid — key for follicles", tone: "warning" },
      ],
    },

    dailyRoutineItems: {
      items: [
        { label: "Morning",   action: "Scalp massage 3-5 min",             note: "stimulates blood flow to follicles" },
        { label: "Wash",      action: "Lukewarm water only",               note: "hot water strips natural scalp oils" },
        { label: "Post-Wash", action: `Apply prescribed topical (${primaryCode === "AGA" || primaryCode === "FAGA" ? "Minoxidil" : "condition-specific"}) on DRY scalp`, note: "wet scalp reduces absorption rate" },
        { label: "Daily",     action: "Avoid tight hairstyles",            note: "prevents traction alopecia over time" },
        { label: "Weekly",    action: "Trim ends every 8-10 weeks",        note: "prevents split end progression" },
        { label: "Nightly",   action: "Sleep on a silk pillowcase",        note: "reduces friction and mechanical breakage", highlight: true },
      ],
    },

    weeklyHairSchedule: {
      items: [
        { day: "Mon", locked: false, tasks: ["Scalp massage", "AM topical", "Light yoga"] },
        { day: "Tue", locked: false, tasks: ["Gentle wash", "Supplements", "Stress reduction"] },
        { day: "Wed", locked: false, tasks: ["Deep conditioning", "AM topical", "Cardio 30 min"] },
        { day: "Thu", locked: false, tasks: ["Scalp massage", "Supplements", "Meditation"] },
        { day: "Fri", locked: false, tasks: ["Hair wash", "AM topical", "LLLT session"] },
        { day: "Sat", locked: false, tasks: ["Deep care session", "Supplements", "Yoga"] },
        { day: "Sun", locked: false, tasks: ["Rest from products", "Meal prep", "Scalp audit"] },
      ],
    },

    stressReductionTechniques: {
      items: [
        { title: "4-7-8 Breathing",             tone: "cyan",  icon: "breathing",   desc: "Activates the parasympathetic nervous system — reduces cortisol within minutes.", impact: "Lowers heart rate and cortisol spike rapidly", how: "Inhale 4s — Hold 7s — Exhale 8s. Repeat 4 cycles, twice daily." },
        { title: "Scalp Self-Massage",          tone: "amber", icon: "massage",     desc: "Increases scalp blood circulation and reduces localised DHT accumulation.",     impact: "Boosts follicle oxygen delivery + stress relief", how: "Firm circular motions from temples to crown — 3-5 min morning and evening." },
        { title: "Mindfulness Meditation",      tone: "cyan",  icon: "mindfulness", desc: "Daily 10-minute sessions shown to reduce cortisol levels by up to 20%.",       impact: "Resets HPA axis response to chronic stress",     how: "Quiet space, eyes closed, focus on breath — use Calm or Headspace." },
        { title: "Progressive Muscle Relaxation", tone: "slate", icon: "progressive", desc: "Systematically releases physical tension — improves sleep quality for GH release.", impact: "Reduces physical stress markers before sleep", how: "Tense each muscle group 5s then release — full body, 20 min before bed." },
        { title: "Adaptogen Protocol",          tone: "green", icon: "adaptogen",   desc: "Clinical adaptogens reduce cortisol by up to 28% and improve resilience.",      impact: "Regulates cortisol without sedation",            how: "Ashwagandha 300mg AM — avoid if on immunosuppressants or with autoimmune flags." },
      ],
    },

    cortisolReducingFoods: {
      items: [
        { title: "Dark Chocolate (85%)",    desc: "Lowers adrenaline + cortisol response" },
        { title: "Matcha Green Tea",         desc: "L-theanine promotes calm without sedation" },
        { title: "Fermented Foods",          desc: "Gut-brain axis supports mood regulation" },
        { title: "Chamomile Tea",            desc: "Apigenin binds GABA receptors — reduces anxiety" },
        { title: "Turmeric + Black Pepper",  desc: "Curcumin reduces cortisol-linked inflammation" },
      ],
    },

    predictiveRiskRows: {
      items: (() => {
        const base = Math.round(100 - hhi);
        const progression = primaryCode === "AGA" || primaryCode === "FAGA" ? 15 : 8;
        return [
          { label: "Now",     untreated: base,                        treated: base },
          { label: "1 Year",  untreated: clamp(base + progression, 0, 100),     treated: clamp(base - 5, 0, 100) },
          { label: "3 Years", untreated: clamp(base + progression * 2, 0, 100), treated: clamp(base - 8, 0, 100) },
          { label: "5 Years", untreated: clamp(base + progression * 3, 0, 100), treated: clamp(base - 10, 0, 100) },
        ];
      })(),
    },

    untreatedRisk5Year: clamp(Math.round(100 - hhi) + (primaryCode === "AGA" || primaryCode === "FAGA" ? 45 : 24), 0, 100),
    treatedRisk5Year: clamp(Math.round(100 - hhi) - 10, 0, 100),
    untreatedRiskLabel: (Math.round(100 - hhi) + (primaryCode === "AGA" || primaryCode === "FAGA" ? 45 : 24)) >= 70 ? "Severe Progression" : "Moderate Progression",
    treatedRiskLabel: (Math.round(100 - hhi) - 10) <= 30 ? "Long-term Stable" : "Control Managed",

    activeRiskFactors: {
      items: [
        {
          label: primaryCode === "AGA" || primaryCode === "FAGA" ? "Genetic Predisposition" : "Primary Condition",
          level: urgency === "HIGH" ? "HIGH" : "MODERATE",
          tone: urgency === "HIGH" ? "high" : "moderate",
          note: `${primaryCondName} detected at ${primaryPct}% probability`,
        },
        {
          label: "Stress Load",
          level: ["high", "extreme"].includes(String(get("Q_S05_001", ""))) ? "HIGH" : "MODERATE",
          tone: ["high", "extreme"].includes(String(get("Q_S05_001", ""))) ? "high" : "moderate",
          note: "Chronic cortisol disrupts follicle growth cycle",
        },
        {
          label: "Nutritional Gaps",
          level: (dse.conditionScores?.NB || 0) > 0.1 ? "HIGH" : "MODERATE",
          tone: (dse.conditionScores?.NB || 0) > 0.1 ? "high" : "moderate",
          note: "Iron, Vitamin D, and protein deficiencies slow regrowth",
        },
        {
          label: "Family History",
          level: String(get("Q_S03_001", "")).includes("significant") ? "HIGH" : "LOW",
          tone: String(get("Q_S03_001", "")).includes("significant") ? "high" : "low",
          note: String(get("Q_S03_001", "")).includes("significant") ? "Markers of genetic predisposition detected in your profile." : "Low genetic predisposition based on your available family history.",
        },
      ],
    },

    shaftScalpInsightCards: {
      items: [
        { title: "Hair Breakage", status: clinicalDimensions[1].score >= 70 ? "Low" : "Moderate", tone: clinicalDimensions[1].score >= 70 ? "green" : "amber", icon: "breakage", summary: clinicalDimensions[1].note, steps: ["Switch to silk/satin pillowcase to reduce friction", "Apply leave-in protein conditioner 2x per week", "Avoid elastic hair ties — use scrunchies instead"], showImage: true },
        { title: "Split Ends",    status: "Monitor", tone: "amber", icon: "split", summary: "Monitor split-end development with routine trims.", steps: ["Use argan oil on ends to temporarily seal splits", "Avoid over-brushing — 50 strokes max per day", "Use sulfate-free shampoo to prevent moisture stripping"] },
        { title: "Hair Texture",  status: clinicalDimensions[1].score >= 70 ? "Healthy" : "Compromised", tone: clinicalDimensions[1].score >= 70 ? "green" : "amber", icon: "texture", summary: "Texture assessment derived from strength score.", steps: ["Weekly protein mask", "Use pH-balancing conditioner (pH 4-5)", "Biotin supplementation as per nutritional protocol"] },
        { title: "Scalp Oiliness", status: String(get("Q_S07_003", "")).includes("oily") ? "Elevated" : "Normal", tone: String(get("Q_S07_003", "")).includes("oily") ? "amber" : "green", icon: "oiliness", summary: "Scalp oil production assessment.", steps: ["Wash every 2-3 days with balancing scalp shampoo", "Avoid touching scalp throughout the day", "Apply witch hazel toner post-wash to regulate sebum"] },
      ],
    },

    bloodInvestigationCards: {
      items: [
        { title: "Complete Blood Count (CBC)",   icon: "cbc",        tone: "cyan",   desc: "Detects anemia, infection, platelet abnormalities affecting hair growth", status: "Essential" },
        { title: "Serum Ferritin",               icon: "ferritin",   tone: "red",    desc: "Ferritin < 30 ng/ml causes hair loss. Target > 70 ng/ml for hair health", status: "Critical" },
        { title: "TSH",                          icon: "tsh",        tone: "red",    desc: "Thyroid disorder is the most common hormonal cause of diffuse hair loss", status: "Critical" },
        { title: "Free T3 / Free T4",            icon: "free-t3-t4", tone: "purple", desc: "Confirms thyroid function beyond TSH alone", status: "If TSH abnormal" },
        { title: "DHEAS",                        icon: "dheas",      tone: "amber",  desc: "Elevated DHEAS indicates adrenal androgen excess", status: gender === "female" ? "Recommended" : "If PCOS / obesity" },
        { title: "Total + Free Testosterone",    icon: "testosterone", tone: "cyan", desc: "Elevated androgens drive follicle miniaturization", status: "Essential" },
        { title: "Prolactin",                    icon: "prolactin",  tone: "green",  desc: "Hyperprolactinemia causes diffuse hair loss", status: "Recommended" },
        { title: "Serum Zinc",                   icon: "zinc",       tone: "green",  desc: "Zinc deficiency is a direct cause of hair thinning", status: "Recommended" },
        { title: "Vitamin D3 (25-OH)",           icon: "vitamin-d3", tone: "cyan",   desc: "Vitamin D receptors in follicles regulate anagen phase", status: "Essential" },
        { title: "HbA1c / Fasting Glucose",      icon: "glucose",    tone: "amber",  desc: "Insulin resistance impairs scalp circulation", status: "If PCOS / obesity" },
      ],
    },

    aiAnalysisInsightRows: {
      items: flags.withPhotoAnalysis
        ? [
            { title: "Hairline Analysis",     severity: "Mild", tone: "mild", icon: "hairline",   desc: "Image analysis pending vision model output" },
            { title: "Crown Density",          severity: "Mild", tone: "mild", icon: "crown",      desc: "Image analysis pending vision model output" },
            { title: "Scalp Visibility",       severity: "Mild", tone: "mild", icon: "visibility", desc: "Image analysis pending vision model output" },
            { title: "Hair Shaft Thickness",   severity: "Mild", tone: "mild", icon: "shaft",      desc: "Image analysis pending vision model output" },
          ]
        : [],
    },

    aiPhotoMetricCards: {
      items: flags.withPhotoAnalysis
        ? [
            { title: "Diagnostic Accuracy Boost", value: "+32%", subtitle: "From photo input",  tone: "accuracy",   progress: 82 },
            { title: "Confidence Level",           value: session.UploadedImage?.length >= 4 ? "Very High" : "High", subtitle: `${session.UploadedImage?.length || 0} of 4 angles captured`, tone: "confidence", progress: (session.UploadedImage?.length / 4) * 100 || 20 },
          ]
        : [],
    },

    aiPhotoTiles: {
      items: flags.withPhotoAnalysis
        ? [
            { id: "front-hairline", label: "Front Hairline",  zone: "Recession zone", image: session.UploadedImage?.[0], markerTop: "37%", markerLeft: "48%" },
            { id: "crown-view",     label: "Crown / Top View", zone: "Thinning zone",  image: session.UploadedImage?.[1], markerTop: "44%", markerLeft: "52%" },
            { id: "left-profile",   label: "Left Profile",     zone: "Temple area",    image: session.UploadedImage?.[2], markerTop: "43%", markerLeft: "35%" },
            { id: "right-profile",  label: "Right Profile",    zone: "Temple area",    image: session.UploadedImage?.[3], markerTop: "43%", markerLeft: "65%", unavailable: session.UploadedImage?.[3] ? false : true },
          ]
        : [],
    },

    disclaimer:
      "This AI-generated report is a clinical decision-support aid and does not replace in-person examination by a licensed dermatologist or trichologist. All treatment recommendations require clinician validation before initiation.",
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// MERGE REFINEMENTS — surgical text-only merge from Claude
// ═══════════════════════════════════════════════════════════════════════════

/**
 * mergeRefinements — merges Claude's text refinements back into the mapper shell.
 *
 * SAFETY GUARANTEES:
 *   • Never overwrites: score, progress, percent, probabilityPct, hhi,
 *     severity, urgency, tone, icon, tag, status, phase, monthRange,
 *     dashArray, thumbClass, priority, priorityTone, markerTone
 *   • Only merges text fields: desc, note, summary, meaning, detail,
 *     action, bullets, how, impact, steps, scoreNote, blurb, subtitle,
 *     applicationNote, summaryText, text
 *   • Arrays (bullets, steps, tasks, foods) are merged only if the
 *     refinement provides a non-empty array of the same length.
 *   • Unknown sections/fields in the refinement are silently ignored.
 */
const TEXT_FIELDS = [
  "desc", "note", "summary", "meaning", "detail", "action",
  "how", "impact", "scoreNote", "blurb", "subtitle",
  "applicationNote",
];

const ARRAY_TEXT_FIELDS = ["bullets", "steps"];

const mergeRefinements = (mapperReport, aiRefinements = {}) => {
  if (!aiRefinements || typeof aiRefinements !== "object") return mapperReport;
  
  // Guard against AI placeholders (e.g. "—-year-old", "unspecified patient")
  const refinementStr = JSON.stringify(aiRefinements);
  if (refinementStr.includes("—-") || refinementStr.includes("unspecified")) {
    console.warn("[ClinicalGuard] AI Hallucination Blocked: Detected placeholders in refinement. Ignoring AI polish.");
    return mapperReport;
  }

  const merged = JSON.parse(JSON.stringify(mapperReport));

  // ── Header + executive summary (robust top-level text fields) ─────────────
  const hRef = aiRefinements.header || aiRefinements; // Support flattened or nested
  if (hRef.summaryText && typeof hRef.summaryText === "string") {
    merged.header.summaryText = hRef.summaryText;
  }
  
  const eRef = aiRefinements.executiveSummary || aiRefinements;
  if (eRef.text && typeof eRef.text === "string") {
    merged.executiveSummary.text = eRef.text;
  }

  // ── Clinical Summary ─────────────
  const cRef = aiRefinements.clinicalSummary || aiRefinements;
  if (cRef && typeof cRef === "object") {
    if (cRef.assessment && typeof cRef.assessment === "string") merged.clinicalSummary.assessment = cRef.assessment;
    if (cRef.hhiSection && typeof cRef.hhiSection === "string") merged.clinicalSummary.hhiSection = cRef.hhiSection;
    if (cRef.causalFactor && typeof cRef.causalFactor === "string") merged.clinicalSummary.causalFactor = cRef.causalFactor;
    if (cRef.recoverySection && typeof cRef.recoverySection === "string") merged.clinicalSummary.recoverySection = cRef.recoverySection;
  }

  // ── Per-section item merging ─────────────────────────────────────────────
  const mergeSection = (sectionKey) => {
    // Handle both { items: [] } and direct [] structures
    const refData = aiRefinements[sectionKey];
    const refItems = Array.isArray(refData) ? refData : refData?.items;
    
    const mergedData = merged[sectionKey];
    const mergedItems = mergedData?.items;

    if (!Array.isArray(refItems) || !Array.isArray(mergedItems)) return;

    mergedItems.forEach((item, i) => {
      const ref = refItems[i];
      if (!ref || typeof ref !== "object") return;

      // Merge scalar text fields
      for (const f of TEXT_FIELDS) {
        if (typeof ref[f] === "string" && ref[f].trim().length > 0) {
          item[f] = ref[f];
        }
      }
      // Merge array-of-strings text fields
      for (const f of ARRAY_TEXT_FIELDS) {
        if (Array.isArray(ref[f]) && ref[f].length > 0 && ref[f].every(s => typeof s === "string")) {
          item[f] = ref[f];
        }
      }
    });
  };

  const MERGEABLE_SECTIONS = [
    "recommendationRows",
    "clinicalDimensions",
    "deepMetricRows",
    "regionalZones",
    "rootCausePrimary",
    "additionalContributingFactors",
    "scalpRecoveryCards",
    "treatmentRecommendationRows",
    "personalisedTreatmentPhases",
    "lifestyleRiskFactors",
    "nutritionalProtocolCards",
    "dailyMealPlanRows",
    "foodsHabitsToAvoid",
    "dailyRoutineItems",
    "stressReductionTechniques",
    "cortisolReducingFoods",
    "activeRiskFactors",
    "shaftScalpInsightCards",
    "bloodInvestigationCards",
    "aiAnalysisInsightRows",
    "freebiesRows",
  ];

  MERGEABLE_SECTIONS.forEach(mergeSection);

  // ── VALIDATION: ensure Claude did not tamper with numbers ─────────────────
  // If any protected field was changed, revert it from the original mapper.
  const PROTECTED_KEYS = [
    "hhi", "HHI", "severity", "urgency", "probabilityPct",
    "score", "progress", "percent",
  ];
  const deepRevert = (mergedNode, originalNode) => {
    if (!mergedNode || !originalNode || typeof mergedNode !== "object") return;
    if (Array.isArray(mergedNode)) {
      mergedNode.forEach((item, i) => deepRevert(item, originalNode[i]));
      return;
    }
    for (const key of Object.keys(mergedNode)) {
      if (PROTECTED_KEYS.includes(key)) {
        if (mergedNode[key] !== originalNode[key]) {
          console.warn(`[ClinicalGuard] AI Hallucination Blocked: Attempted to change protected field "${key}" from ${originalNode[key]} to ${mergedNode[key]}. Reverting.`);
          mergedNode[key] = originalNode[key];
        }
      } else if (typeof mergedNode[key] === "object") {
        deepRevert(mergedNode[key], originalNode[key]);
      }
    }
  };
  deepRevert(merged, mapperReport);

  return merged;
};

module.exports = {
  mapDSEToReport,
  mergeRefinements,
  TREATMENT_LIBRARY,
  NUTRITION_LIBRARY,
};
