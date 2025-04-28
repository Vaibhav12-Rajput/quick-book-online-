const mongoose = require('mongoose');  // Corrected import
const BaseEntitySchema = require('./BaseEntity');
// Define the configuration schema
const ConfigSchema = new mongoose.Schema({
    ...BaseEntitySchema, // Include common fields from BaseEntity

    terms: { type: String, required: true }, // Payment terms
    keepQBInvoiceNumber: { type: Boolean, required: true } // Keep QB Invoice number flag
});

// Create a Mongoose model for the configuration
module.exports = mongoose.model('Config', ConfigSchema);
