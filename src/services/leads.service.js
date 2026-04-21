const { Lead } = require("../models");

/**
 * TrichoScan AI — Lead Generation & Qualifying Intelligence
 * 
 * Implements PRD §1.2 & §7.1: Converts diagnostic results into 
 * actionable leads for the medical/sales team.
 * CONVERTED TO SEQUELIZE (POSTGRES)
 */
class LeadService {
  /**
   * Qualifies a clinical session as a lead based on their DSE and Vision results.
   */
  async qualifyAndSaveLead(leadId, dseResult, visionAnalysis) {
    try {
      if (!leadId) return;

      const { hairHealthIndex, severityBand, urgencyFlag, primaryConditions } = dseResult;
      
      let priorityScore = 0;
      let tags = [];

      if (urgencyFlag === "URGENT") { priorityScore += 50; tags.push("HOT_LEAD"); }
      else if (urgencyFlag === "HIGH") { priorityScore += 30; tags.push("HIGH_PRIORITY"); }

      if (severityBand === "SEVERE") { priorityScore += 30; tags.push("CRITICAL_CONDITION"); }
      else if (severityBand === "SIGNIFICANT") { priorityScore += 15; }

      if (primaryConditions.includes("SA")) tags.push("SURGICAL_INTERVENTION");
      if (primaryConditions.includes("CA")) tags.push("CANCER_FOLLOWUP");
      
      if (visionAnalysis?.compositeConfidence?.score > 85) {
        tags.push("VERIFIED_BY_AI");
      }

      const leadCategory = this._getLeadCategory(priorityScore);

      // Update Lead model
      await Lead.update({
        category: leadCategory,
        priorityScore: priorityScore,
        tags: tags,
        metadataSummary: `HHI: ${hairHealthIndex} | Urgency: ${urgencyFlag} | Condition: ${primaryConditions[0]}`
      }, {
        where: { id: leadId }
      });

      console.log(`[LeadService] Lead ${leadId} qualified as ${leadCategory} (Score: ${priorityScore}).`);
    } catch (error) {
      console.error("[LeadService] Qualification error:", error.message);
    }
  }

  _getLeadCategory(score) {
    if (score >= 80) return "HOT_LEAD";
    if (score >= 50) return "WARM_LEAD";
    if (score >= 20) return "COLD_LEAD";
    return "ORGANIC_NURTURE";
  }
}

module.exports = new LeadService();
