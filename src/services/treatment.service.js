/**
 * Deterministic Treatment Engine (TRE) — TrichoScan AI §7.1
 * 
 * Maps clinical conditions to standardized 3-phase treatment protocols.
 * 
 * Phases:
 * 1 (0-3m): Immediate actions & Stabilisation
 * 2 (3-6m): Active Treatment & Follicle Stimulation
 * 3 (6-12m): Maintenance & Long-term Growth
 */

const TREATMENTS = {
  "AGA": {
    label: "Androgenetic Alopecia",
    phases: {
      one: ["Stabilize hair fall with Minoxidil 5%", "Biotin supplementation (5mg/day)", "Switch to Ketoconazole 2% Shampoo"],
      two: ["Continue Minoxidil application", "Analyze for Derma-rolling (1.5mm) every 15 days", "PRP Session #1"],
      three: ["Maintenance dose adjustment", "Scalp micro-pigmentation if required", "Assess for Hair Transplant"]
    }
  },
  "TELOGEN_EFFLUVIUM": {
    label: "Telogen Effluvium",
    phases: {
      one: ["Nutrition Panel (Ferritin, Vitamin D/B12)", "Stress management therapy", "Iron supplementation (based on labs)"],
      two: ["Hair follicle nourishment serums", "Scalp nutrition infusion", "Low-Level Laser Therapy (LLLT)"],
      three: ["Gradual tapering of supplements", "Maintain clean diet & scalp hygiene", "Routine assessment"]
    }
  },
  "ALOPECIA_AREATA": {
    label: "Alopecia Areata",
    phases: {
      one: ["Clinical referral for Corticosteroid injection", "Topical Clobetasol Propionate", "Anti-inflammatory diet"],
      two: ["Monitor for patch regrowth", "Continue topical irritants", "Immunotherapy assessment"],
      three: ["Maintenance with topical Minoxidil", "Follow-up every 3 months", "Psychological support if needed"]
    }
  },
  "DEFAULT": {
    label: "General Hair Thinning",
    phases: {
      one: ["Anti-dandruff routine", "Multivitamin & Omega-3 supplements", "Cold water rinses"],
      two: ["Aromatherapy scalp massage", "Reduce heat styling", "Improved hydration"],
      three: ["Maintain consistent sleep cycle", "Healthy protein intake", "Biannual TrichoScan"]
    }
  }
};

/**
 * Builds a deterministic treatment plan based on the primary condition.
 * 
 * @param {string} conditionId - Normalized condition code (from DSE)
 * @returns {Object} 3-Phase Plan
 */
function getTreatmentPlan(conditionId) {
  const code = conditionId?.toUpperCase() || "DEFAULT";
  const base = TREATMENTS[code] || TREATMENTS["DEFAULT"];

  return {
    condition: base.label,
    phases: [
      { id: 1, title: "Initial Rescue (0-3 Months)", tasks: base.phases.one },
      { id: 2, title: "Stabilisation (3-6 Months)", tasks: base.phases.two },
      { id: 3, title: "Regrowth & Maintenance (6-12+ Months)", tasks: base.phases.three }
    ]
  };
}

module.exports = {
  getTreatmentPlan
};
