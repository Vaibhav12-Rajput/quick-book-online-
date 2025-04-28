const QuickbooksDao = require('../dao/QuickbooksDao');
const logger = require('../config/logger');
const { updateAccessToken } = require('./QuickbooksAuthService ');


async function runTask() {
  try {
    logger.info('Checking and updating QuickBooks credentials...');
    const quickBooksConnections = await QuickbooksDao.findAll();
    for (const quickBooks of quickBooksConnections) {
      await updateAccessToken(quickBooks);
    }
  } catch (error) {
    logger.error(`Error in task execution: ${error.message}`);
  }
}

// Run immediately after starting the app
runTask();

// Then set an interval to run every 30 minutes (1800000 milliseconds)
setInterval(runTask, 1800000); // 30 minutes in milliseconds
