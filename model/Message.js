const mongoose = require('mongoose');
mongoose.set('strictQuery', false); // Affects query filter behavior (not document saves)

const records = new mongoose.Schema({
    workOrderId: { type: String, required: true },
    invoiceId: { type: String, required: true },
    DocNumber: {type: String, required: false},
    qbCompanyConfigCode: { type: String, required: true },
    status: { type: String, default: "FAILURE" },
    invoiceDate: { type: Date, required: true },
    qBInvoiceProcessingDate: { type: Date, default: Date.now },
    errorMessage: { type: String, required: true }
}, { timestamps: true }); // This will add createdAt and updatedAt fields

// Create and export the model
module.exports = mongoose.model('records', records);
