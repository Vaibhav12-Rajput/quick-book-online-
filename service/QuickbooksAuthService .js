const OAuthClient = require('intuit-oauth');
const { v4: uuidv4 } = require('uuid');
const QuickbooksDao = require('../dao/QuickbooksDao');
const ConfigDao = require('../dao/ConfigDao');
const { response } = require('express');
const logger = require('../config/logger');
const { validationResult } = require('express-validator');
const CommonResponsePayload = require('../payload/commonResponsePayload');
require('dotenv').config();


const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_uri = process.env.REDIRECT_URI;
const environment = process.env.ENVIRONMENT;



const oauthClient = new OAuthClient({
  clientId: client_id,
  clientSecret: client_secret,
  environment: redirect_uri,
  redirectUri: redirect_uri,
  environment: environment,
  logging: true,
});

// Start OAuth flow, save CSRF token to DB, and generate OAuth URI
async function startOauthFlow(companyName) {

  const config = await ConfigDao.findOne({ id: companyName });
  if (!config) {
    logger.error(`Configuration not found for id: ${companyName}`);
    throw new Error(`Configuration not found for id: ${companyName}`);
  }
  
  const csrf = generateCSRFToken();

  // Generate OAuth URI with saved CSRF
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: csrf,
    response_type : "code",
  });

  return authUri;
}



// Generate CSRF token (simple random string)
function generateCSRFToken() {
  return Math.random().toString(36).substring(2);
}

// Handle callback after user authorizes QuickBooks
async function handleCallback(authCode, state, realmId, url) {
  // Exchange authorization code for access token and other details
  const tokenResponse = await oauthClient.createToken(url);
  const bearerTokenResponse = tokenResponse.getJson();

  // Save QuickBooks credentials in the database
  const quickbooksData = {
    id: uuidv4(),
    realmId,
    csrf: state,
    authCode,
    refreshToken: bearerTokenResponse.refresh_token,
    expiresIn: bearerTokenResponse.expires_in,
    accessToken: bearerTokenResponse.access_token,
    intuitTid: bearerTokenResponse.intuit_tid,
    idToken: bearerTokenResponse.id_token,
    tokenType: bearerTokenResponse.token_type,
    accessTokenLastRefreshedTime: new Date(),
    refreshTokenExpiredTime: bearerTokenResponse.x_refresh_token_expires_in,
    isRefreshTokenExpired: false,
  };

  // Save credentials to DB
  await QuickbooksDao.insert(quickbooksData);

  // Redirect to the UI page
  const redirectUrl = process.env.REDIRECT_UI_URL ;
  return redirectUrl;
}


async function updateAccessToken(quickBooks) {
  try {
    if (!oauthClient) {
      throw new Error('OAuth client is not initialized');
    }
    if(!quickBooks.refreshToken){
      throw new Error('Refresh token is not available');
    }

    const bearerTokenResponse = await oauthClient.refreshUsingToken(quickBooks.refreshToken);
    logger.info('OAuth Refresh Token Response:', bearerTokenResponse);
    if (!bearerTokenResponse.token.access_token  || !bearerTokenResponse.token.refresh_token ) {
      throw new Error('Failed to get new access or refresh token');
    }
    const updateData = {
      accessToken: bearerTokenResponse.token.access_token,
      refreshToken: bearerTokenResponse.token.refresh_token,
    };

    const updatedQuickBooks = await QuickbooksDao.findAndModify(quickBooks._id, updateData);
  } catch (error) {
    // Detailed error logging for debugging
    logger.error(`Failed to update access token for userId: ${quickBooks.userId}, email: ${quickBooks.userEmail}. Error: ${error.stack || error.message}`);
  }
}
async function writeConfig(req) {
  let responsePayload;
  const errors = validationResult(req);

  // Check validation errors
  if (!errors.isEmpty()) {
      let responseMessage = "Validation Failed";
      logger.error(responseMessage);
      throw new Error(responseMessage);  // Throw error to be handled in the router
  }

  let companyId;
  let companyName;

  // Extract company details from the request body
  for (const key in req.body) {
      if (req.body.hasOwnProperty(key) && key.startsWith('company') && req.body[key]) {
          companyId = key;  // Assuming the key is company1, company2, etc.
          companyName = req.body[key]; // File path or name associated with the company
      }
  }

  let config = {
      id: companyId,
      name: companyName,
      terms: req.body.terms,
      keepQBInvoiceNumber: req.body.keepQBInvoiceNumber
  };

  try {
      // Check if the configuration already exists for the given companyId
      const existingConfig = await ConfigDao.findOne({ Id: companyId });

      if (existingConfig) {
          // Update the existing configuration if found
          await ConfigDao.findAndModify(existingConfig._id, config);
          let responseMessage = "Configuration updated successfully";
          logger.info(responseMessage);
          return responseMessage;  // Return the success message
      } else {
          // Insert a new configuration if not found
          await ConfigDao.insert(config, companyId);
          let responseMessage = "Configuration created successfully";
          logger.info(responseMessage);
          return responseMessage;  // Return the success message
      }
  } catch (err) {
      logger.error(err);
      throw new Error("Something went wrong while saving the configuration.");  // Throw error to be handled in the router
  }
}

module.exports = { startOauthFlow, handleCallback, updateAccessToken, writeConfig };
