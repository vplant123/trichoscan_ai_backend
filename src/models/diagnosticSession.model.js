const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const crypto = require('crypto');

const STATES = [
    "INIT",
    "QUESTIONNAIRE_IN_PROGRESS",
    "QUESTIONNAIRE_COMPLETE",
    "PHOTOS_UPLOADED",
    "ANALYSIS_QUEUED",
    "ANALYSIS_IN_PROGRESS",
    "ANALYSIS_COMPLETE",
    "LEAD_CAPTURED",
    "REPORT_QUEUED",
    "REPORT_IN_PROGRESS",
    "REPORT_COMPLETE",
    "ERROR",
    "ABANDONED"
];

const DiagnosticSession = sequelize.define('DiagnosticSession', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    sessionId: {
        type: DataTypes.UUID,
        defaultValue: () => crypto.randomUUID(),
        unique: true,
    },
    leadId: {
        type: DataTypes.UUID,
        allowNull: true,
    },
    status: {
        type: DataTypes.ENUM(...STATES),
        defaultValue: 'INIT',
        allowNull: false,
    },
    startedAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    lastActivityAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    expiresAt: {
        type: DataTypes.DATE,
        defaultValue: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
    answers: {
        type: DataTypes.JSONB,
        defaultValue: {},
    },
    completionRate: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    UploadedImage: {
        type: DataTypes.JSONB,
        defaultValue: [],
    },
    verificationOtp: {
        type: DataTypes.STRING,
    },
    isVerified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    },
    dseResult: {
        type: DataTypes.JSONB,
    },
    visionAnalysis: {
        type: DataTypes.JSONB,
    },
    visionAdjustedScores: {
        type: DataTypes.JSONB,
    },
    compositeConfidence: {
        type: DataTypes.JSONB,
    },
    clinicalNarrative: {
        type: DataTypes.JSONB,
    },
    treatmentRecommendations: {
        type: DataTypes.JSONB,
    },
    predictionImageData: {
        type: DataTypes.JSONB,
    },
    reportUrl: {
        type: DataTypes.STRING,
    },
    reportFileKey: {
        type: DataTypes.STRING,
    },
    reportGeneratedAt: {
        type: DataTypes.DATE,
    },
    pipelineStatus: {
        type: DataTypes.JSONB,
        defaultValue: {
            dse: "PENDING",
            vision: "PENDING"
        },
    },
    retryCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
    },
    maxRetries: {
        type: DataTypes.INTEGER,
        defaultValue: 5,
    },
    errorCode: {
        type: DataTypes.STRING,
    },
    errorMessage: {
        type: DataTypes.TEXT,
    },
    skipPhotoAnalysis: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
    }
}, {
    timestamps: true,
});

DiagnosticSession.prototype.transitionTo = async function (nextState, options = {}) {
    this.status = nextState;
    this.lastActivityAt = new Date();
    return this.save(options);
};

DiagnosticSession.prototype.checkCompletion = function () {
    const minRequiredCount = 20;
    const actualCount = Object.keys(this.answers).length;
    this.completionRate = Math.round((actualCount / minRequiredCount) * 100);
    return this.completionRate >= 80;
};

module.exports = { DiagnosticSession, STATES };
