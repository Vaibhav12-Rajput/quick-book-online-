// logger.js
const winston = require('winston');

// Create a logger instance
const logger = winston.createLogger({
  level: 'info',  // Default log level (can be 'info', 'error', 'debug', etc.)
  format: winston.format.combine(
    winston.format.colorize(),  // Colors the logs
    winston.format.timestamp(),  // Add a timestamp to each log
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;  // Custom log message format
    })
  ),
  transports: [
    new winston.transports.Console(), // Logs to the console
    new winston.transports.File({ filename: 'app.log' }) // Logs to a file
  ]
});

// Export the logger
module.exports = logger;
