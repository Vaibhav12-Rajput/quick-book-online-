const OAuthClient = require('intuit-oauth');
const { v4: uuidv4 } = require('uuid');
const QuickbooksDao = require('../dao/QuickbooksDao');
const { response } = require('express');
const logger = require('../config/logger');
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
async function startOauthFlow(appType) {
  const csrf = generateCSRFToken();

  // Save CSRF token to DB with other optional fields
  await QuickbooksDao.insert({
    id: uuidv4(),
    csrf: csrf,
    name: `CSRF-${new Date().getTime()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    appType: appType // Optionally save appType if needed
  });

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
    userId: bearerTokenResponse.user_id,
    userEmail: bearerTokenResponse.user_email,
    idToken: bearerTokenResponse.id_token,
    tokenType: bearerTokenResponse.token_type,
    accessTokenLastRefreshedTime: new Date(),
    refreshTokenExpiredTime: bearerTokenResponse.x_refresh_token_expires_in,
    isRefreshTokenExpired: false,
  };

  // Save credentials to DB
  await QuickbooksDao.insert(quickbooksData);

  // Redirect to the UI page
  const redirectUrl = process.env.REDIRECT_UI_URL || 'http://your-redirect-url.com';
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


module.exports = { startOauthFlow, handleCallback, updateAccessToken };
