/**
 * TrichoScan AI — Questionnaire Branching Logic Engine
 * 
 * Implements PRD §2.1.3: Server-side validation of active question paths (BR-001 to BR-008).
 * This ensures that if a user skips a section (e.g. PCOS) in the UI, 
 * the DSE only scores valid, active question branches.
 */

const BRANCHING_RULES = [
  {
    id: "BR_001_MALE_ROUTING",
    description: "Activate male-specific questions",
    trigger: (answers) => answers["Q_S01_002"] === "male",
    activates: [] // Norwood selector is removed from new set
  },
  {
    id: "BR_002_FEMALE_ROUTING",
    description: "Activate female-specific questions",
    trigger: (answers) => answers["Q_S01_002"] === "female",
    activates: ["Q_S04_009", "Q_S10_001", "Q_S10_002", "Q_S10_003", "Q_S10_004", "Q_S10_005"]
  },
  {
    id: "BR_003_RAPID_ONSET",
    description: "Activate rapid onset questions",
    trigger: (answers) => ["lt_3_months", "3_6_months"].includes(answers["Q_S02_001"]) && answers["Q_S02_002"] === "sudden",
    activates: [] // Extended Qs are removed from new set
  },
  {
    id: "BR_004_SCALP_CONDITION",
    description: "Activate itching + scaling deep questions",
    trigger: (answers) => answers["Q_S07_001"] !== "none" && answers["Q_S07_003"] !== "none",
    activates: []
  },
  {
    id: "BR_005_CHEMICAL_TREATMENT",
    description: "Activate chemical treatment questions",
    trigger: (answers) => answers["Q_S06_003"] !== "never",
    activates: []
  },
  {
    id: "BR_006_SOUTH_ASIAN",
    description: "Activate region-specific questions",
    trigger: (answers) => answers["Q_S01_003"] === "south_asian",
    activates: [] 
  },
  {
    id: "BR_007_PATERNAL_GENETIC",
    description: "Activate genetic deep questions",
    trigger: (answers) => ["paternal", "both"].includes(answers["Q_S03_001"]),
    activates: []
  },
  {
    id: "BR_008_HIGH_STRESS",
    description: "Activate stress-related questions",
    trigger: (answers) => ["high", "extreme"].includes(answers["Q_S05_001"]),
    activates: []
  }
];

/**
 * Evaluates which conditional branches are active based on a set of answers.
 * Returns a list of Question IDs that are "Active".
 */
function getActiveQuestions(answers) {
  const activeQuestionIds = new Set();
  
  // Base questions are always active (non-conditional)
  // These are S01, S02 (basics), S03, S05 (basics), etc.
  // Conditional questions are added via rules.
  
  BRANCHING_RULES.forEach(rule => {
    if (rule.trigger(answers)) {
      rule.activates.forEach(qId => activeQuestionIds.add(qId));
    }
  });
  
  return Array.from(activeQuestionIds);
}

/**
 * Validates whether a specific branching rule Is "Active" given the answers.
 * Used for DSE rule gating §2.1.3.
 */
function validateActivePath(ruleId, answers) {
  const rule = BRANCHING_RULES.find(r => r.id === ruleId);
  if (!rule) return false;
  return rule.trigger(answers);
}

module.exports = {
  getActiveQuestions,
  validateActivePath,
  BRANCHING_RULES
};
