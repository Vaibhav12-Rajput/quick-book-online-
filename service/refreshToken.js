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

runTask();

setInterval(runTask, 1800000); 
