const QuickBooks = require('node-quickbooks');
const quickbooksDao = require('../dao/QuickbooksDao');
const CommonResponsePayload = require('../payload/commonResponsePayload');
const ConfigDao = require('../dao/ConfigDao');
const  qbOnlineConstant  = require('../constant/qbdConstants');

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
                    } else {
                        // Tax validation passed, create or validate customer
                        const customer = await this.validateOrCreateCustomer(invoicePayload.to);

                        // Create invoice in QuickBooks
                        const invoiceResponse = await this.createInvoiceInQBO(invoicePayload, customer, config);
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

    async createInvoiceInQBO(invoicePayload, customer, config) {
        const lineItems = [];
        // Add parts to the invoice
        invoicePayload.lines.forEach(line => {
            line.parts?.forEach(part => {
                lineItems.push({
                    "Amount": part.totalAmount,
                    "DetailType": "SalesItemLineDetail",
                    "SalesItemLineDetail": {
                        "ItemRef": {
                            "value": part.itemId // Use the item ID, not the name
                        },
                        "UnitPrice": part.sellingPrice,
                        "Qty": part.quantity,
                    }
                });
            });
            line.labors?.forEach(labor => {
                lineItems.push({
                    "Amount": labor.totalAmount,
                    "DetailType": "SalesItemLineDetail",
                    "SalesItemLineDetail": {
                        "ItemRef": {
                            "value": labor.itemId // Use the labor item ID
                        },
                        "UnitPrice": labor.laborPerHour,
                        "Qty": labor.hours
                    }
                });
            });
        });

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
            "DueDate": invoicePayload.invoiceDate + 30,
            "PONumber": invoicePayload.PONumber,
            "SalesTermRef": {
                "value": termsRef
            },
            "PrivateNote": "FOB: WorkOrderId-12345",
            "DocNumber": "WO-1234"
        };
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
                    TaxApplicableOn:  saleTaxCodePayload.TaxType 
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
