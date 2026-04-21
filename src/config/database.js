const { Sequelize } = require('sequelize');
const config = require('./config');
const logger = require('./logger');

const sequelize = new Sequelize(config.sequelize.url, config.sequelize.options);

const connectDB = async () => {
  try {
    await sequelize.authenticate();
    logger.info('✅ PostgreSQL connected successfully via Sequelize');
    
    
    if (config.env === 'development') {
      await sequelize.sync({ alter: true });
      logger.info('Database models synced');
    }
  } catch (error) {
    logger.error('❌ Unable to connect to the database:', error);
    process.exit(1);
  }
};

module.exports = {
  sequelize,
  connectDB
};
