const { connectDB } = require('./config/database');
const app = require('./app');
const config = require('./config/config');
const logger = require('./config/logger');

const { startWorkers } = require('./workers');

let server;
connectDB().then(() => {
  console.log("=========================================");
  console.log("INITIALIZING BACKGROUND WORKERS...");
  console.log("=========================================");
  startWorkers();
  server = app.listen(config.port, () => {
    logger.info(`Listening to port ${config.port}`);
  });
});

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error) => {
  logger.error(error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  if (server) {
    server.close();
  }
});
