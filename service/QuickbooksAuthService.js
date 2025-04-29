const OAuthClient = require('intuit-oauth');
const { v4: uuidv4 } = require('uuid');
const { validationResult } = require('express-validator');
const { response } = require('express');
require('dotenv').config();

const QuickbooksDao = require('../dao/QuickbooksDao');
const ConfigDao = require('../dao/ConfigDao');
const logger = require('../config/logger');
const CommonResponsePayload = require('../payload/commonResponsePayload');
const { InvoiceService } = require('./InvoiceService');

const invoiceService = new InvoiceService();

// Environment variables
const {
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI,
  ENVIRONMENT,
  REDIRECT_UI_URL,
} = process.env;

// Scopes
const SCOPES = [OAuthClient.scopes.Accounting];

// Initialize OAuth client
const oauthClient = new OAuthClient({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  environment: ENVIRONMENT,
  redirectUri: REDIRECT_URI,
  logging: false,
});

// CSRF Generator
const generateCSRFToken = () => Math.random().toString(36).substring(2);

// Start OAuth flow
async function startOauthFlow(companyName) {
  const config = await ConfigDao.findOne({ id: companyName });
  if (!config) {
    const errMsg = `Configuration not found for id: ${companyName}`;
    logger.error(errMsg);
    throw new Error(errMsg);
  }

  const csrf = generateCSRFToken();

  const authUri = oauthClient.authorizeUri({
    scope: SCOPES,
    state: csrf,
    response_type: 'code',
  });

  return authUri;
}

// Handle OAuth callback
async function handleCallback(authCode, state, realmId, url) {
  const tokenResponse = await oauthClient.createToken(url);
  const tokenJson = tokenResponse.getJson();

  const quickbooksData = buildQuickBooksData(authCode, state, realmId, tokenJson);
  await QuickbooksDao.insert(quickbooksData);

  const configList = await ConfigDao.findAll();
  for (const config of configList) {
    await invoiceService.createDefaultTax(config);
  }

  return REDIRECT_UI_URL;
}

function buildQuickBooksData(authCode, state, realmId, token) {
  return {
    id: uuidv4(),
    realmId,
    csrf: state,
    authCode,
    refreshToken: token.refresh_token,
    expiresIn: token.expires_in,
    accessToken: token.access_token,
    intuitTid: token.intuit_tid,
    idToken: token.id_token,
    tokenType: token.token_type,
    accessTokenLastRefreshedTime: new Date(),
    refreshTokenExpiredTime: token.x_refresh_token_expires_in,
    isRefreshTokenExpired: false,
    tokenExpiry: Date.now() + token.expires_in * 1000
  };
}

// Write or update configuration
async function writeConfig(req) {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const errMsg = `Validation failed for companyId=${req.body?.companyId}`;
    logger.error(errMsg);
    throw new Error('Validation Failed');
  }

  const { companyId, companyName } = extractCompanyInfo(req.body);
  const config = buildConfigObject(req.body, companyId, companyName);

  try {
    const existingConfig = await ConfigDao.findOne({ id: companyId });

    if (existingConfig) {
      await ConfigDao.findAndModify(existingConfig._id, config);
      return 'Configuration updated successfully';
    } else {
      await ConfigDao.insert(config, companyId);
      return 'Configuration created successfully';
    }
  } catch (err) {
    logger.error(`Error saving config for companyId=${companyId}: ${err.message}`, {
      stack: err.stack,
    });
    throw new Error('Something went wrong while saving the configuration.');
  }
}

function extractCompanyInfo(body) {
  let companyId, companyName;

  for (const key in body) {
    if (body.hasOwnProperty(key) && key.startsWith('company') && body[key]) {
      companyId = key;
      companyName = body[key];
    }
  }

  return { companyId, companyName };
}

function buildConfigObject(body, companyId, companyName) {
  return {
    id: companyId,
    name: companyName,
    terms: body.terms,
    keepQBInvoiceNumber: body.keepQBInvoiceNumber,
    salesTaxAgence: body.salesTaxAgency,
  };
}

module.exports = {
  startOauthFlow,
  handleCallback,
  writeConfig,
};
