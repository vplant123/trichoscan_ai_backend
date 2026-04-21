const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { encryptPII } = require('../utils/security');

const Lead = sequelize.define('Lead', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  sessionId: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true,
  },
  name: {
    type: DataTypes.TEXT,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    validate: {
      isEmail: true,
    },
  },
  phone: {
    type: DataTypes.TEXT,
  },
  consent: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  category: {
    type: DataTypes.ENUM('HOT_LEAD', 'WARM_LEAD', 'COLD_LEAD', 'ORGANIC_NURTURE'),
    defaultValue: 'COLD_LEAD',
  },
  priorityScore: {
    type: DataTypes.INTEGER,
  },
  tags: {
    type: DataTypes.JSONB,
    defaultValue: [],
  },
  metadataSummary: {
    type: DataTypes.TEXT,
  },
}, {
  hooks: {
    beforeSave: (lead) => {
      if (lead.changed('name') && lead.name) {
        lead.name = encryptPII(lead.name);
      }
      if (lead.changed('email') && lead.email) {
        lead.email = encryptPII(lead.email).toLowerCase();
      }
      if (lead.changed('phone') && lead.phone) {
        lead.phone = encryptPII(lead.phone);
      }
    },
  },
});

module.exports = Lead;
