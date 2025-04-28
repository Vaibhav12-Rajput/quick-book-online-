const mongoose = require('mongoose');

// Define the schema for failure records
const FailureRecordSchema = new mongoose.Schema({
    workOrderId: { type: String, required: true },
    qbCompanyConfigCode: { type: String, required: true },
    status: { type: String, default: "FAILURE" },
    invoiceDate: { type: Date, required: true },
    qBInvoiceProcessingDate: { type: Date, default: Date.now },
    errorMessage: { type: String, required: true }
}, { timestamps: true }); // This will add createdAt and updatedAt fields

// Create and export the model
module.exports = mongoose.model('FailureRecord', FailureRecordSchema);
