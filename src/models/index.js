const { DiagnosticSession } = require('./diagnosticSession.model');
const Lead = require('./lead.model');

DiagnosticSession.belongsTo(Lead, { foreignKey: 'leadId', as: 'lead' });
Lead.hasMany(DiagnosticSession, { foreignKey: 'leadId', as: 'sessions' });


Lead.belongsTo(DiagnosticSession, { foreignKey: 'sessionId', as: 'session' });

module.exports = {
    DiagnosticSession,
    Lead
};
