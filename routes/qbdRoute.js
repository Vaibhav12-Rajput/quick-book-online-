const express = require('express');
const QuickbooksAuthService = require('../service/QuickbooksAuthService ');
const { InvoiceService } = require('../service/InvoiceService');
const router = express.Router();
const invoiceService = new InvoiceService();


router.post('/write', async (req, res) => {
  try {
      // Call writeConfig and await its response
      const result = await QuickbooksAuthService.writeConfig(req);
      
      // Return success response with the message from the service
      res.status(200).send({
          message: result,  // This is the success message returned by the service
          data: {},         // You can add any additional data if needed
      });
  } catch (error) {
      // In case of an error, return the error message
      logger.error('Error in /write route:', error.message);
      res.status(400).send({ error: error.message });
  }
});

// Route to start OAuth flow
router.get('/connect', async (req, res) => {
  try {
    const companyName = req.query.companyName;
    const result = await QuickbooksAuthService.startOauthFlow(companyName);
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
