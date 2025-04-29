const QuickBooks = require('node-quickbooks');
const quickbooksDao = require('../dao/QuickbooksDao');
const CommonResponsePayload = require('../payload/commonResponsePayload');
const ConfigDao = require('../dao/ConfigDao');
const { promisify } = require('util');
const failureRecordDao = require('../dao/RecordDao'); // Import the DAO
const logger = require('../config/logger');
const RecordDao = require('../dao/RecordDao');
const qbOnlineConstant = require('../constant/qbdConstants');



const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;

class InvoiceService {
    constructor() {
        this.qb = null;
    }

    async initializeQuickBooks() {
        const quickbooks = await quickbooksDao.findOne();
        this.qb = new QuickBooks(
            client_id,
            client_secret,
            quickbooks.accessToken,
            false,
            quickbooks.realmId,
            true,
            true,
            null,
            '2.0',
            quickbooks.minorVersion || 65
        );
    }

    // Create invoice method using the QuickBooks SDK
    createInvoiceQBO = async (req, res) => {
        const invoicePayloadList = req.body.invoiceList;
        const companyName = req.body.qbCompanyConfigCode;
        const config = await ConfigDao.findOne({ id: companyName });
        if (!config) {
            throw new Error(`Configuration not found for id: ${companyName}`);
        }

        try {
            // Initialize QuickBooks if not already done
            if (!this.qb) {
                await this.initializeQuickBooks();
            }

            let responsePayload;
            let responseMessage;
            let reponseList = [];
            let taxesFromQB = await this.getAllSalesTaxFromQBO();

            // Process each invoice
            for (const invoicePayload of invoicePayloadList) {
                console.log(`Processing invoice for workOrderId: ${invoicePayload.workOrderId}`);
                try {
                    let misMatchedTaxes = await this.validateSalesTax(invoicePayload, taxesFromQB);

                    if (misMatchedTaxes.length > 0) {
                        responseMessage = `Sales Tax does not match for company`;
                        reponseList.push({
                            message: responseMessage,
                            workOrderId: invoicePayload.workOrderId,
                            taxDetails: misMatchedTaxes,
                            status: "FAILURE"
                        });
                        await failureRecordDao.insertOrUpdateForFailure(invoicePayload.workOrderId, error.message, invoicePayload.invoiceDate, companyName);
                    } else {
                        // Tax validation passed, create or validate customer
                        const customer = await this.validateOrCreateCustomer(invoicePayload.to);

                        // Create invoice in QuickBooks
                        let invoiceResponse = await this.getItemAndProcessInvoice(invoicePayload, companyName, customer, config);
                        // const invoiceResponse = await this.createInvoiceInQBO(invoicePayload, customer, config);
                        responseMessage = "Invoice created Successfully.";
                        reponseList.push({
                            ...invoiceResponse,
                            message: responseMessage,
                        });
                    }
                } catch (error) {
                    console.error("Error creating invoice:", error.message);
                    let response = await failureRecordDao.insertOrUpdateForFailure(invoicePayload.workOrderId, error.message, invoicePayload.invoiceDate, companyName);
                    reponseList.push({
                        ...response,
                        message: error.message
                    });
                }
            }

            // Return response to client
            responsePayload = new CommonResponsePayload("Invoices processed", { invoicesResponse: reponseList });
            return res.status(201).send(responsePayload);
        } catch (error) {
            console.error('QuickBooks API error:', error.message);
            return res.status(500).json({
                message: 'Failed to create invoice in QuickBooks',
                error: error.message
            });
        }
    };

    // Get all sales tax from QuickBooks using the SDK
    async getAllSalesTaxFromQBO() {
        const criteria = {};  // Optionally add criteria for filtering the tax rates if needed
        try {
            // Call the findTaxRates method with criteria and handle the result using a promise
            const data = await new Promise((resolve, reject) => {
                this.qb.findTaxRates(criteria, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });

            const taxRates = data?.QueryResponse?.TaxRate || [];
            console.log(`Found ${taxRates.length} sales tax rates in QBO.`);

            return taxRates;
        } catch (error) {
            console.error("Error fetching sales tax rates:", error.message);
            throw new Error("Failed to fetch sales tax rates from QuickBooks Online.");
        }
    }


    // async insertOrUpdateInDBForFailure(workOrderId, errorMessage, invoiceDate, qbCompanyConfigCode) {
    //     try {
    //         const failureRecord = await failureRecordDao.insertOrUpdateForFailure(workOrderId, errorMessage, invoiceDate, qbCompanyConfigCode);
    //         console.log('Failure record processed:', failureRecord);
    //     } catch (err) {
    //         console.error('Error processing failure:', err);
    //     }
    // };

    async createInvoiceInQBO(invoicePayload, customer, config) {
        const lineItems = [];
        // Add parts to the invoice
        for (const line of invoicePayload.lines) {
            try {
                // Add parts to the invoice
                for (const part of line.parts || []) {
                    // Await the result of getItemIdByName to get the itemId
                    const itemId = await this.getItemIdByName(part.name);

                    const lineItem = {
                        "Amount": part.totalAmount,
                        "DetailType": "SalesItemLineDetail",
                        "SalesItemLineDetail": {
                            "ItemRef": {
                                "value": itemId
                            },
                            "UnitPrice": part.sellingPrice,
                            "Qty": part.quantity,
                        }
                    };

                    // Add TaxCodeRef only when taxCode is available
                    if (part.taxCode) {
                        lineItem.SalesItemLineDetail = {
                            "TaxCodeRef": {
                                "value": part.taxCode
                            }
                        }
                    }

                    lineItems.push(lineItem);
                }


                // Add miscellaneous charges
                for (const charge of line.miscCharges || []) {
                    // Assuming you need an itemId for the miscellaneous charge, but it's unclear if getItemIdByName is required
                    const itemId = await this.getItemIdByName(charge.name); // Or any appropriate name for misc charges

                    lineItems.push({
                        Amount: charge.totalAmount,
                        DetailType: "SalesItemLineDetail",
                        SalesItemLineDetail: {
                            ItemRef: {
                                value: itemId,
                            },
                            Qty: 1, // Usually 1 for misc charges unless otherwise
                        }
                    });
                }

                if (invoice.laborTaxSameAsPart == false && labors.length > 0) {
                    if (invoice.laborTaxPercentage > 0) {
                        const itemId = await this.getItemIdByName("Labor Tax"); // Or any appropriate name for misc charges
                        lineItems.push({
                            ItemRef: {
                                value: itemId,
                            },
                            Qty: 1,
                        })
                    }
                }

                // Add disposal taxes
                for (const tax of line.disposalTaxes || []) {
                    const itemId = await this.getItemIdByName(charge.name);
                    lineItems.push({
                        Amount: tax.totalAmount,
                        DetailType: "SalesItemLineDetail",
                        SalesItemLineDetail: {
                            ItemRef: {
                                value: itemId, // Assuming this is a fixed value for disposal taxes
                            },
                            UnitPrice: tax.amount,
                            Qty: 1, // Usually 1 for disposal/tax unless otherwise
                        }
                    });
                }

            } catch (error) {
                console.error(`Error processing line items: ${error.message}`);
                // Handle error or continue with default behavior
            }
        }


        const termsRef = await this.getTermRef(config);
        const invoice = {
            "Line": [
                ...lineItems,
            ],
            "CustomerRef": {
                "value": customer[0].Id // Use customer ID, not name
            },
            "TxnDate": invoicePayload.invoiceDate, // Ensure correct date format
            "TotalAmt": invoicePayload.finalTotal,
            "BillAddr": {
                "Line1": invoicePayload.from.address.line1,
                "City": invoicePayload.from.address.city,
                "CountrySubDivisionCode": invoicePayload.from.address.state,
                "PostalCode": invoicePayload.from.address.zipcode,
                "Country": invoicePayload.from.address.country
            },
            "DueDate": invoicePayload.invoiceDate, // Optional, but ensure correct format
            "SalesTermRef": {
                "value": termsRef
            },
        };

        if (config?.keepQBInvoiceNumber) {
            invoice.DocNumber = invoicePayload.workOrderId;
          }

        if (invoicePayload.partsTax && invoicePayload.partsTax.length > 0) {
            // 1. Choose your tax group (here we just take the first one)
            const { value, name, taxAmount } = invoicePayload.partsTax[0];

            invoice.TxnTaxDetail = {
                TxnTaxCodeRef: { value, name },
                TotalTax: taxAmount           // omit this line if you’d rather let QBO auto‐calculate
            };
        }


        try {
            const createdInvoice = await new Promise((resolve, reject) => {
                this.qb.createInvoice(invoice, (err, data) => {
                    if (err) {
                        reject(new Error(`Error creating invoice in QBO: ${err.message}`));
                    } else {
                        resolve(data);
                    }
                });
            });

            console.log(`Invoice created with ID: ${createdInvoice.Id}`);
            return createdInvoice;

        } catch (error) {
            console.error("Error creating invoice in QBO:", error.message);
            throw new Error("Failed to create invoice in QuickBooks Online.");
        }
    }

    // Validate or create customer in QuickBooks
    async validateOrCreateCustomer(customer) {
        try {
            const existingCustomer = await this.getCustomerByName(customer.name);
            if (!existingCustomer) {
                console.log(`Creating new customer: ${customer.name}`);
                return await this.createNewCustomer(customer);
            } else {
                console.log(`Customer ${customer.name} already exists.`);
                return existingCustomer;
            }
        } catch (error) {
            console.error("Error validating or creating customer:", error.message);
            throw new Error("Failed to validate or create customer.");
        }
    }

    async getCustomerByName(customerName) {
        try {
            // Define the criteria to search customers by name
            const criteria = {
                DisplayName: customerName
            };

            // Call the findCustomers method with the criteria and handle the result using a promise
            const data = await new Promise((resolve, reject) => {
                this.qb.findCustomers(criteria, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });

            // Check if customer data was returned and extract it
            return data?.QueryResponse?.Customer;

        } catch (error) {
            console.error("Error fetching customer data:", error.message);
            throw new Error("Failed to fetch customer data from QuickBooks Online.");
        }
    }

    async getItemIdByName(itemName) {
        const criteria = {
            Name: itemName
        };

        try {
            // Promisify the findItems function to return a Promise
            const findItemsAsync = promisify(this.qb.findItems.bind(this.qb));

            // Await the result of the promisified function
            const data = await findItemsAsync(criteria);

            if (data && data.QueryResponse && data.QueryResponse.Item && data.QueryResponse.Item.length > 0) {
                return data.QueryResponse.Item[0].Id;
            } else {
                return [];  // Return an empty array if no item found
            }
        } catch (err) {
            // Handle errors, such as connection issues or invalid responses
            throw new Error(`Error fetching item ID: ${err.message}`);
        }
    }


    // Create a new customer in QuickBooks
    async createNewCustomer(customer) {
        const customerPayload = {
            DisplayName: customer.name,
            PrimaryEmailAddr: { Address: customer.email },
            PrimaryPhone: { FreeFormNumber: customer.mobilePhone },
            BillAddr: {
                Line1: customer.address.line1, // Corrected field names (capitalized)
                Line2: customer.address.line2, // Ensure this is an empty string or null if not provided
                City: customer.address.city,
                CountrySubDivisionCode: customer.address.state, // Corrected to use 'CountrySubDivisionCode' for state
                PostalCode: customer.address.zipcode, // Corrected to 'PostalCode'
                Country: customer.address.country
            },
            GivenName: customer.firstName || "", // Optionally add first and last name if available
            FamilyName: customer.lastName || "",
        };

        try {
            // Wrap the createCustomer method in a promise
            const createdCustomer = await new Promise((resolve, reject) => {
                this.qb.createCustomer(customerPayload, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });

            // Log and return the created customer
            console.log(`Customer '${customer.name}' created successfully!`);
            return createdCustomer;
        } catch (error) {
            console.error("Error creating customer:", error.message);
            throw new Error("Failed to create new customer in QuickBooks Online.");
        }
    }



    // Sales tax validation logic
    async validateSalesTax(invoice, taxesFromQB) {
        const taxesFromInvoice = this.prepareTaxListForValidation(invoice);
        const activeTaxes = taxesFromQB.filter(tax => tax.Active === true);
        return this.findMismatchedTaxes(taxesFromInvoice, activeTaxes);
    }

    prepareTaxListForValidation(invoice) {
        let taxes = [...invoice.partsTax];
        if (invoice.laborTaxSameAsPart === false && invoice.laborTaxPercentage) {
            taxes.push({
                "name": "Labor Tax",
                "code": "Labor Tax",
                "tax": invoice.laborTaxPercentage,
                "taxAmount": invoice.laborTax,
            });
        }
        return taxes;
    }

    findMismatchedTaxes(invoiceTaxes, qbTaxes) {
        const mismatchedTaxes = [];
        for (const invTax of invoiceTaxes) {
            const qbTax = qbTaxes.find(tax => tax.Name === invTax.name);
            if (!qbTax) {
                mismatchedTaxes.push({
                    name: invTax.name,
                    code: invTax.code,
                    tax: parseFloat(invTax.tax).toFixed(2) + " %",
                    description: `${invTax.code} not found in QuickBooks.`,
                });
            } else if (parseFloat(invTax.tax) !== parseFloat(qbTax.RateValue)) {
                mismatchedTaxes.push({
                    name: invTax.name,
                    code: invTax.code,
                    tax: parseFloat(invTax.tax).toFixed(2) + " %",
                    taxInQB: parseFloat(qbTax.RateValue).toFixed(2) + " %",
                    description: "Tax rate mismatch between FleetFixy and QuickBooks.",
                });
            }
        }
        return mismatchedTaxes;
    }

    async getTermRef(config) {
        try {
            const termName = config.terms; // e.g., "Due on receipt" from your config

            if (!termName) {
                throw new Error('No terms specified in config.');
            }

            // Query QuickBooks for existing Terms
            const terms = await this.getTerm(termName);
            if (!terms) {
                throw new Error('No matching Term found between the configuration and QuickBooks.');
            }

            console.log(`Created new term '${termName}' with ID ${terms.Id}`);
            return terms[0].Id;

        } catch (error) {
            console.error("Error in getOrCreateTermRef:", error.message);
            throw new Error("Failed to fetch or create Terms in QuickBooks Online.");
        }
    }


    async getTerm(templateName) {
        try {
            const criteria = { Name: templateName };

            const data = await new Promise((resolve, reject) => {
                this.qb.findTerms(criteria, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });

            const terms = data?.QueryResponse?.Term || [];

            return terms;
        } catch (error) {
            console.error("Error fetching TermRef:", error.message);
            throw new Error("Failed to fetch TermRef from QuickBooks Online.");
        }
    }

    async createNonSalesTaxQBO(config) {
        const taxVendorName = config.TaxAgent;
        const salexTaxReturnLine = config.SalexTaxReturnLine;

        // If taxVendorName is not found in config
        if (!taxVendorName) {
            throw new Error("Company got connected but exception while creating sales tax item. Error : taxVendorName is not found in config");
        }

        // Prepare the data for the new sales tax item
        const salesTaxItem = {
            Name: "Zero Sales Tax for 0%",  // You can customize the name
            Description: "Zero Sales Tax for 0%",  // Description of the tax item
            Active: true,
            Type: "SalesTax", // Type should be SalesTax for QuickBooks Online
            Rate: 0.0, // Zero rate for this item
            VendorRef: {
                value: await this.getVendorId(taxVendorName)
            },
            TaxReturnLine: salexTaxReturnLine, // Optional, if needed for reporting purposes
        };

        try {
            const created = await new Promise((resolve, reject) => {
                this.qb.createTaxService(taxServicePayload, (err, resp) => {
                    if (err) reject(err);
                    else resolve(resp.TaxCode);
                });
            });

            // Check if the item is created successfully
            if (!createdTaxItem) {
                throw new Error("Error: Failed to create sales tax item in QuickBooks Online.");
            }

            return createdTaxItem;
        } catch (error) {
            logger.error("Error creating sales tax item: " + error.message);
            throw new Error("Failed to create sales tax item in QuickBooks Online.");
        }
    }



    async getTaxAgencyId(taxAgencyName) {
        try {
            const agencies = await new Promise((resolve, reject) => {
                this.qb.findTaxAgencies({ Name: taxAgencyName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data?.QueryResponse?.TaxAgency || []);
                });
            });

            if (!agencies.length) {
                throw new Error(`No TaxAgency found with name: ${taxAgencyName}`);
            }

            return agencies[0].Id;
        } catch (error) {
            throw new Error("Failed to get Vendor ID: " + error.message);
        }
    }

    async getInvoiceById(invoiceId) {
        try {
            const invoice = await new Promise((resolve, reject) => {
                this.qb.getInvoice(invoiceId, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(data);
                    }
                });
            });
            return invoice;
        } catch (error) {
            console.error("Error fetching invoice by ID:", error.message);
            // throw new Error("Failed to fetch invoice from QuickBooks Online.");
        }
    }

    async deleteInvoieById(invoiceId) {
        try {
            const deletedInvoice = await new Promise((resolve, reject) => {
                this.qb.deleteInvoice(invoiceId, (err, data) => {
                    if (err) {
                        reject(new Error(`Error deleting invoice in QBO: ${err.message}`));
                    } else {
                        resolve(data);
                    }
                });
            });
            // console.log(`Invoice deleted with ID: ${deletedInvoice.Id}`);
            return deletedInvoice;
        } catch (error) {
            console.error("Error deleting invoice in QBO:", error.message);
            // throw new Error("Failed to delete invoice in QuickBooks Online.");
        }
    }


    async getItemAndProcessInvoice(invoice, companyName, customer, config) {
        let invoiceIdToDelete;
        let oldInvoiceFound;

        let oldInvoiceRecord = await RecordDao.findOldInvoiceRecord(invoice.workOrderId, companyName);

        let existingQbInvoiceId = oldInvoiceRecord ? oldInvoiceRecord.invoiceId : invoice.invoiceId;

        if (existingQbInvoiceId) {
            logger.info("Invoice creating again")
            if (oldInvoiceRecord && oldInvoiceRecord.DocNumber) {//
                invoiceIdToDelete = oldInvoiceRecord.invoiceId;
                logger.info(`Picked invTxnIdToDelete from db : ${invoiceIdToDelete} for workOrderId : ${invoice.workOrderId} and qbInvoiceNumber : ${existingQbInvoiceId}`)

            } else {
                const invoiceResponse = await this.getInvoiceById(existingQbInvoiceId);

                if (invoiceResponse) {
                    invoiceIdToDelete = invoiceResponse.Id;
                } else {
                    oldInvoiceFound = false;
                }
            }
        }

        let status = "";

        let createdInvoice = await this.createInvoiceInQBO(invoice, customer, config);
        let DocNumber = createdInvoice.DocNumber;
        let invoiceId = createdInvoice.Id;

        if (invoiceIdToDelete) {
            status = await this.deleteInvoieById(invoiceIdToDelete);
            status = "UPDATED"
        }
        else if (existingQbInvoiceId && !invoiceIdToDelete) {
            status = oldInvoiceFound == false ? "OLD INVOICE NOT FOUND" : "DUPLICATE OLD INVOICES FOUND"
        } else {
            status = "CREATED"
        }

        oldInvoiceRecord = await failureRecordDao.insertOrUpdateInDBForSuccess(invoice.workOrderId, DocNumber, status, invoiceId, companyName);
        return oldInvoiceRecord;
    }

    async createDefaultTax(config) {
        try {
            await this.initializeQuickBooks();
            await this.validateOrCreateTaxCode(qbOnlineConstant.TAX_CODES.ZERO_SALES_TAX_CODE, config);
            await this.validateOrCreateTaxCode(qbOnlineConstant.TAX_CODES.ZERO_NON_SALES_TAX_CODE, config);
        } catch (error) {
            console.error('Failed to create default Rate and Code ', error.message);
            throw error;
        }
    }
    async validateOrCreateTaxCode(taxCode, config) {
        const existingTaxRate = await this.getSalesTaxCode(taxCode);
        if (!existingTaxRate || existingTaxRate.length === 0) {
            console.log(`Creating new TaxCode: ${taxCode}`);
            return await this.createNewTaxCode(taxCode, config);
        } else {
            console.log(`TaxCode '${taxCode}' already exists.`);
            return existingTaxRate[0].Id;
        }
    }
    async getSalesTaxCode(taxRateName) {
        try {
            const criteria = { Name: taxRateName };
            const data = await new Promise((resolve, reject) => {
                this.qb.findTaxCodes(criteria, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
            return data?.QueryResponse?.TaxCode || [];
        } catch (error) {
            console.error('Error fetching TaxCode:', error.message);
            throw error;
        }
    }
    async createNewTaxCode(code, config) {
        const taxAgencyId = await this.getTaxAgencyId(config.salesTaxAgence);
        const saleTaxCodePayload = this.buildTaxRatePayload(code);
        const taxServicePayload = {
            TaxCode: saleTaxCodePayload.Name,
            TaxRateDetails: [
                {
                    TaxRateName: `${saleTaxCodePayload.Name}Rate`,
                    RateValue: saleTaxCodePayload.RateValue,
                    TaxAgencyId: taxAgencyId,
                    TaxApplicableOn: saleTaxCodePayload.TaxType
                }
            ]
        };
        try {
            const created = await new Promise((resolve, reject) => {
                this.qb.createTaxService(taxServicePayload, (err, resp) => {
                    if (err) reject(err);
                    else resolve(resp.TaxCode);
                });
            });
            console.log("Created TaxCode:", created);
            return created.Id;
        } catch (error) {
            console.error("Error creating TaxCode:", error);
            throw error;
        }
    }
    async getTaxAgencyId(taxAgencyName) {
        try {
            const agencies = await new Promise((resolve, reject) => {
                this.qb.findTaxAgencies({ Name: taxAgencyName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data?.QueryResponse?.TaxAgency || []);
                });
            });
            if (!agencies.length) {
                throw new Error(`No TaxAgency found with name: ${taxAgencyName}`);
            }
            return agencies[0].Id;
        } catch (error) {
            console.error('Error fetching TaxAgency:', error.message);
            throw error;
        }
    }
    buildTaxRatePayload(code) {
        const isZeroTax = code === qbOnlineConstant.TAX_CODES.ZERO_SALES_TAX_CODE;
        return {
            Name: code,
            Description: isZeroTax ? 'Zero Sales Tax Code' : 'Non-Zero Sales Tax Code',
            RateValue: isZeroTax ? 0 : 5,
            TaxType: "Sales"
        };
    }
}

module.exports = { InvoiceService };
