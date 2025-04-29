const express = require('express');
const QuickbooksAuthService = require('../service/QuickbooksAuthService ');
const { InvoiceService } = require('../service/InvoiceService');
const router = express.Router();
const invoiceService = new InvoiceService();

// Utility function to handle successful responses
const sendSuccessResponse = (res, message, data = {}) => {
  res.status(200).send({
    message,
    data,
  });
};

// Utility function to handle error responses
const sendErrorResponse = (res, error, statusCode = 400) => {
  console.error(error.message); // Log the error for debugging
  res.status(statusCode).send({
    error: error.message,
  });
};

// Route to write config
router.post('/write', async (req, res) => {
  try {
    const result = await QuickbooksAuthService.writeConfig(req);
    sendSuccessResponse(res, result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Route to start OAuth flow
router.get('/connect', async (req, res) => {
  try {
    const companyName = req.query.companyName;
    const result = await QuickbooksAuthService.startOauthFlow(companyName);
    sendSuccessResponse(res, 'Connection created successfully', result);
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Callback after OAuth flow
router.get('/callback', async (req, res) => {
  const { code: authCode, state, realmId } = req.query;

  if (!authCode || !state || !realmId) {
    return sendErrorResponse(res, new Error('Missing required parameters'), 400);
  }

  try {
    const redirectUrl = await QuickbooksAuthService.handleCallback(authCode, state, realmId, req.originalUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    sendErrorResponse(res, error);
  }
});

// Route to create invoice
router.post('/create-invoice', async (req, res) => {
  try {
    await invoiceService.createInvoiceQBO(req, res);
  } catch (error) {
    sendErrorResponse(res, error, 500);
  }
});

module.exports = router;
