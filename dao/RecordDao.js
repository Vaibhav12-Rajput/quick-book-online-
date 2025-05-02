const Record = require('../model/Message');

class RecordDao {
    async insertOrUpdateForFailure(workOrderId, errorMessage, invoiceDate, qbCompanyConfigCode) {
        const filter = { workOrderId, qbCompanyConfigCode };
        const update = {
            $set: {
                status: "FAILURE",
                invoiceDate: new Date(invoiceDate),
                qBInvoiceProcessingDate: new Date(),
                errorMessage: errorMessage
            }
        };
        const options = { upsert: true, new: true }; // new: true ensures updated document is returned
        return await Record.findOneAndUpdate(filter, update, options);
    }


    async insertOrUpdateInDBForSuccess(DocNumber ,invoiceId, status, invoiceDate, qbCompanyConfigCode) {
        const filter = { DocNumber, qbCompanyConfigCode };
        const update = {
            $set: {
                workOrderId: DocNumber,
                invoiceId: invoiceId,
                status: status,
                invoiceDate: invoiceDate,
                qBInvoiceProcessingDate: new Date(),
                qbCompanyConfigCode: qbCompanyConfigCode,
                errorMessage: ""
            }
        };
        const options = { upsert: true, new: true }; // new: true ensures updated document is returned
        return await Record.findOneAndUpdate(filter, update, options);
    }

    async findOldInvoiceRecord(DocNumber, qbCompanyConfigCode) {
        const filter = { DocNumber, qbCompanyConfigCode };
        return await Record.findOne(filter);
    }

    async insert(data) {
        const entity = new Record(data);
        return await entity.save();
    }

    async findOne(query) {
        return await Record.findOne(query);
    }

    async findAll() {
        return await Record.find({});
    }

    async removeAll() {
        return await Record.deleteMany({});
    }

    async count(query) {
        return await Record.countDocuments(query);
    }

    async findAndRemove(id) {
        return await Record.findOneAndDelete({ _id: id });
    }
}

module.exports = new RecordDao();
