const mongoose = require('mongoose');

const BaseEntitySchema = {
  id: { type: String },
  name: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
};

module.exports = BaseEntitySchema;
