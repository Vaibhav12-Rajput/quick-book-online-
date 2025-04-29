const mongoose = require('mongoose');  // Corrected import
const BaseEntitySchema = require('./BaseEntity');

const QuickbooksSchema = new mongoose.Schema({  // Use mongoose.Schema here
  ...BaseEntitySchema,

  realmId: String,
  csrf: String,
  authCode: String,
  isRefreshTokenExpired: Boolean,
  accessTokenLastRefreshedTime: Date,
  refreshTokenExpiredTime: Number,
  refreshToken: String,
  expiresIn: Number,
  idToken: String,
  tokenType: String,
  accessToken: String,
  intuitTid: String,
  tokenExpiry: Date
});

module.exports = mongoose.model('Quickbooks', QuickbooksSchema);
