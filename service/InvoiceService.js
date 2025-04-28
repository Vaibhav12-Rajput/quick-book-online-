const QuickBooks = require('node-quickbooks');
const quickbooksDao = require('../dao/QuickbooksDao');
const CommonResponsePayload = require('../payload/commonResponsePayload');

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
                    } else {
                        // Tax validation passed, create or validate customer
                        const customer = await this.validateOrCreateCustomer(invoicePayload.to);

                        // Create invoice in QuickBooks
                        const invoiceResponse = await this.createInvoiceInQBO(invoicePayload, customer);
                        responseMessage = "Invoice created Successfully.";
                        reponseList.push({
                            ...invoiceResponse,
                            message: responseMessage,
                        });
                    }
                } catch (error) {
                    console.error("Error creating invoice:", error.message);
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


    // callback = function(err, data) {
    //     if (err) {
    //         console.error("Error :", err);
    //     } else {
    //         console.log("Tax :", data);
    //     }
    // };

    // Create invoice in QuickBooks using the SDK

    async createInvoiceInQBO(invoicePayload, customer) {

        const lineItems = [];
        // Add parts to the invoice
        invoicePayload.lines.forEach(line => {
            line.parts?.forEach(part => {

                this.qb.findItems

                lineItems.push({
                    "Amount": part.totalAmount,
                    "DetailType": "SalesItemLineDetail",
                    "SalesItemLineDetail": {
                        "ItemRef": {
                            "value": part.name
                        },
                        "UnitPrice": part.sellingPrice,
                        "Qty": part.quantity,
                        "TaxCodeRef": {
                            "value": part.taxCode
                        }
                    }
                });
            });

            // Add miscellaneous charges
            line.miscCharges?.forEach(charge => {
                lineItems.push({
                    Amount: charge.totalAmount,
                    DetailType: "SalesItemLineDetail",
                    SalesItemLineDetail: {
                        ItemRef: {
                            value: 23,
                        },
                        Qty: 1, // Usually 1 for misc charges unless otherwise
                    }
                });
            });

            // Add disposal taxes
            line.disposalTaxes?.forEach(tax => {
                lineItems.push({
                    Amount: tax.totalAmount,
                    DetailType: "SalesItemLineDetail",
                    SalesItemLineDetail: {
                        ItemRef: {
                            value: 25,
                        },
                        UnitPrice: tax.amount,
                        Qty: 1, // Usually 1 for disposal/tax unless otherwise
                    }
                });
            });
        });

        
        // Create the invoice payload
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
            "PONumber": invoicePayload.PONumber, // Optional, ensure it exists
        };

        if (invoicePayload.partsTax && invoicePayload.partsTax.length > 0) {
            invoice["TxnTaxDetail"] = {
                "TaxLine": invoicePayload.partsTax.map(tax => ({
                    "DetailType": "TaxLineDetail",
                    "TaxLineDetail": {
                        "TaxRateRef": {
                            "value": tax.code // Reference the tax rate code
                        },
                    }
                }))
            };
        }

        try {
            const createdInvoice = await new Promise((resolve, reject) => {
                // Use the SDK's createInvoice method with the callback style
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
}

module.exports = { InvoiceService };
