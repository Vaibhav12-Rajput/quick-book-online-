const FailureRecord = require('../model/ErrorMessage'); // Import the FailureRecord model

class FailureRecordDao {
    async insertOrUpdateForFailure(workOrderId, errorMessage, invoiceDate, qbCompanyConfigCode) {
        try {
            // Define the filter to match existing records
            const filter = { workOrderId, qbCompanyConfigCode };

            // Define the update data
            const update = {
                $set: {
                    status: "FAILURE",
                    invoiceDate: new Date(invoiceDate),
                    qBInvoiceProcessingDate: new Date(),
                    errorMessage: errorMessage
                }
            };

            // Define options for upsert (insert if not exists) and return the updated document
            const options = {
                upsert: true, // Create a new document if no matching record is found
                returnDocument: "after" // Returns the updated document after modification
            };

            // Use Mongoose's findOneAndUpdate method to insert or update the record
            const result = await FailureRecord.findOneAndUpdate(filter, update, options);

            // Log success based on whether the record was updated or inserted
            // if (result) {
            //     if (result.isNew) {
            //         logger.info(`Record inserted in db for workOrderId: ${workOrderId}, qbCompanyConfigCode: ${qbCompanyConfigCode} and status: "FAILURE"`);
            //     } else {
            //         logger.info(`Record updated in db for workOrderId: ${workOrderId}, qbCompanyConfigCode: ${qbCompanyConfigCode} and status: "FAILURE"`);
            //     }
            // }

            return result; // Return the resulting document

        } catch (err) {
            // logger.error(`MongoDB error in insertOrUpdateForFailure: ${err.message}`);
            throw err;
        }
    }

    async findOldInvoiceRecord(workOrderId, qbCompanyConfigCode) {
        try {
            // Define the filter to search for the invoice record
            const filter = { workOrderId, qbCompanyConfigCode };

            // Use Mongoose's findOne to fetch the record
            const result = await FailureRecord.findOne(filter);

            // Log the result (Optional)
            if (result) {
                logger.info(`Invoice record found for workOrderId: ${workOrderId}, qbCompanyConfigCode: ${qbCompanyConfigCode}`);
            } else {
                logger.info(`No invoice record found for workOrderId: ${workOrderId}, qbCompanyConfigCode: ${qbCompanyConfigCode}`);
            }

            // Return the result (it could be null if not found)
            return result;
        } catch (err) {
            // Handle errors, log them
            logger.error(`Error finding old invoice record: ${err.message}`);
            throw err; // Rethrow to propagate error
        }
    }
}

module.exports = new FailureRecordDao(); // Export the DAO instance
