const express = require('express');
const QuickbooksAuthService = require('../service/QuickbooksAuthService ');
const { InvoiceService } = require('../service/InvoiceService');
const router = express.Router();
const invoiceService = new InvoiceService();


// Simple health check endpoint
router.get('test/', (req, res) => {
  res.send('Application Connected to QuickBooks Desktop');
});

// Route to start OAuth flow
router.get('/', async (req, res) => {
  const appType = req.query.appType; // Assuming appType is passed as a query parameter
  if (!appType) {
    return res.status(400).send({ error: 'AppType is required' });
  }

  try {
    const result = await QuickbooksAuthService.startOauthFlow(appType);
    res.status(200).send({
      message: 'Connection created successfully',
      data: result,
    });
  } catch (error) {
    res.status(400).send({ error: error.message });
  }
});

router.get('/callback', async (req, res) => {
  const { code: authCode, state, realmId } = req.query;

  if (!authCode || !state || !realmId) {
    return res.status(400).send({ error: 'Missing required parameters' });
  }

  try {
    const redirectUrl = await QuickbooksAuthService.handleCallback(authCode, state, realmId, req.originalUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error during callback:', error);
    res.status(400).send({ error: 'An error occurred while handling the callback.' });
  }
});


router.post('/create-invoice', async (req, res) => {
  try {
    await invoiceService.createInvoiceQBO(req, res);  
  } catch (error) {
    console.error("Error processing the invoice:", error.message);
    return res.status(500).json({
      message: 'Error creating invoice.',
      error: error.message
    });
  }
});


module.exports = router;
