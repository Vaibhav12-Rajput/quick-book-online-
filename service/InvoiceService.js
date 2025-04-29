const QuickBooks = require('node-quickbooks');
const quickbooksDao = require('../dao/QuickbooksDao');
const CommonResponsePayload = require('../payload/commonResponsePayload');
const ConfigDao = require('../dao/ConfigDao');
const { promisify } = require('util');
const failureRecordDao = require('../dao/RecordDao');
const logger = require('../config/logger');
const RecordDao = require('../dao/RecordDao');
const qbOnlineConstant = require('../constant/qbdConstants');
const OAuthClient = require('intuit-oauth');
const QuickbooksDao = require('../dao/QuickbooksDao');
const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;

const {
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI,
    ENVIRONMENT,
  } = process.env;


class InvoiceService {
    constructor() {
        this.qb = null;
    }

    async initializeQuickBooks() {
        try {
            const quickbooks = await quickbooksDao.findOne();            
            await this.ensureValidAccessToken(quickbooks);
            this.qb = new QuickBooks(
                client_id,
                client_secret,
                quickbooks.accessToken,
                false,
                quickbooks.realmId,
                true,
                false,
                null,
                '2.0',
                quickbooks.minorVersion || 65
            );
            logger.info('QuickBooks client initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize QuickBooks client', error);
            throw error;
        }
    }

    async ensureValidAccessToken(quickBooks) {

        const now = Date.now();
        const bufferTime = 2 * 60 * 1000;

        if (!quickBooks.tokenExpiry || quickBooks.tokenExpiry - now <= bufferTime) {
            try {                
                const oauthClient = new OAuthClient({
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET,
                    environment: ENVIRONMENT,
                    redirectUri: REDIRECT_URI,
                    logging: false,
                });


                const bearerTokenResponse = await oauthClient.refreshUsingToken(quickBooks.refreshToken);
                const { access_token, refresh_token, expires_in } = bearerTokenResponse.token;

                const updateData = {
                    accessToken: access_token,
                    refreshToken: refresh_token,
                    tokenExpiry: now + expires_in * 1000
                };

                await QuickbooksDao.findAndModify(quickBooks._id, updateData);
                quickBooks.accessToken = access_token;
            } catch (error) {
                logger.error(`Token refresh failed for _id=${quickBooks._id}: ${error.message}`);
                throw new Error('Failed to refresh QuickBooks token');
            }
        }
    }


    createInvoiceQBO = async (req, res) => {
        try {
            const invoicePayloadList = req.body.invoiceList;
            const companyName = req.body.qbCompanyConfigCode;
            
            const config = await this.getCompanyConfig(companyName);
            await this.initializeQuickBooksIfNeeded();

            const taxesFromQB = await this.getAllSalesTaxFromQBO();
            const reponseList = await this.processInvoiceList(invoicePayloadList, companyName, taxesFromQB, config);

            const responsePayload = new CommonResponsePayload("Invoices processed", { invoicesResponse: reponseList });
            return res.status(201).send(responsePayload);
        } catch (error) {
            logger.error('QuickBooks API error:', error);
            return res.status(500).json({
                message: 'Failed to create invoice in QuickBooks',
                error: error.message
            });
        }
    };

    async getCompanyConfig(companyName) {
        logger.info(`Fetching configuration for company: ${companyName}`);

        const config = await ConfigDao.findOne({ id: companyName });
        if (!config) {
            logger.error(`Error Getting config details for company: ${companyName}`);
            throw new Error(`Configuration not found for id: ${companyName}`);
        }
        return config;
    }

    async initializeQuickBooksIfNeeded() {
        if (!this.qb) {
            await this.initializeQuickBooks();
        }
    }

    async processInvoiceList(invoicePayloadList, companyName, taxesFromQB, config) {
        const reponseList = [];
        
        for (const invoicePayload of invoicePayloadList) {
            try {
                logger.info(`Processing invoice for workOrderId: ${invoicePayload.workOrderId}`);
                
                const misMatchedTaxes = await this.validateSalesTax(invoicePayload, taxesFromQB);
                if (misMatchedTaxes.length > 0) {
                    logger.info(`Tax mismatch found for company: ${companyName}. Mismatched taxes: ${JSON.stringify(misMatchedTaxes)}`);
                    await this.handleTaxMismatch(invoicePayload, companyName, misMatchedTaxes, reponseList);
                    continue;
                }

                const customer = await this.validateOrCreateCustomer(invoicePayload.to);
                const invoiceResponse = await this.getItemAndProcessInvoice(invoicePayload, companyName, customer, config);
                
                reponseList.push({
                    ...invoiceResponse,
                    message: "Invoice created Successfully.",
                });
            } catch (error) {
                logger.error(`Error processing invoice ${invoicePayload.workOrderId}:`, error);
                await this.handleInvoiceError(invoicePayload, companyName, error, reponseList);
            }
        }
        
        return reponseList;
    }

    async handleTaxMismatch(invoicePayload, companyName, misMatchedTaxes, reponseList) {
        const responseMessage = `Sales Tax does not match for company`;
        reponseList.push({
            message: responseMessage,
            workOrderId: invoicePayload.workOrderId,
            taxDetails: misMatchedTaxes,
            status: "FAILURE"
        });
        
        await failureRecordDao.insertOrUpdateForFailure(
            invoicePayload.workOrderId, 
            responseMessage, 
            invoicePayload.invoiceDate, 
            companyName
        );
    }

    async handleInvoiceError(invoicePayload, companyName, error, reponseList) {
        const response = await failureRecordDao.insertOrUpdateForFailure(
            invoicePayload.workOrderId, 
            error.message, 
            invoicePayload.invoiceDate, 
            companyName
        );
        
        reponseList.push({
            ...response,
            message: error.message
        });
    }

    async getAllSalesTaxFromQBO() {
        try {
            const data = await new Promise((resolve, reject) => {
                this.qb.findTaxRates({}, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            const taxRates = data?.QueryResponse?.TaxRate || [];
            logger.info(`Found ${taxRates.length} sales tax rates in QBO`);
            return taxRates;
        } catch (error) {
            logger.error("Error fetching sales tax rates:", error);
            throw new Error("Failed to fetch sales tax rates from QuickBooks Online.");
        }
    }

    async createInvoiceInQBO(invoicePayload, customer, config) {
        try {
            const lineItems = await this.buildLineItems(invoicePayload);
            const invoice = await this.buildInvoiceObject(invoicePayload, customer, config, lineItems);

            if (config?.keepQBInvoiceNumber) {
                invoice.DocNumber = invoicePayload.workOrderId;
            }

            this.addTaxDetailsIfNeeded(invoice, invoicePayload);

            const createdInvoice = await this.createInvoiceInQuickBooks(invoice);
            logger.info(`Invoice created with ID: ${createdInvoice.Id}`);
            return createdInvoice;
        } catch (error) {
            logger.error("Error creating invoice in QBO:", error);
            throw new Error("Failed to create invoice in QuickBooks Online.");
        }
    }

    async buildLineItems(invoicePayload) {
        const lineItems = [];

        logger.info(`Starting to process line items for invoice payload.`);

        for (const line of invoicePayload.lines) {
            await this.processParts(line.parts, lineItems);
            await this.processMiscCharges(line.miscCharges, lineItems);
            await this.processDisposalTaxes(line.disposalTaxes, lineItems);
            
            logger.info(`Line Item process done for work order id ${invoicePayload}`);
            if (invoicePayload.laborTaxSameAsPart === false && invoicePayload.laborTaxPercentage > 0) {
                logger.info(`Adding labor tax item. laborTaxSameAsPart: false, laborTaxPercentage: ${invoicePayload.laborTaxPercentage}, workOrderId: ${invoicePayload.workOrderId}`);
                lineItems.push(await this.createLaborTaxItem());
            }
        }
        
        return lineItems;
    }

    async processParts(parts, lineItems) {
        if (!parts) {
            logger.info(`No parts to process company: ${companyName}`);
            return;
        }

        for (const part of parts) {
            logger.info(`Processing part: ${part.name}, Qty: ${part.quantity}, Price: ${part.sellingPrice}`);
            const itemId = await this.getItemIdByName(part.name);
            const lineItem = {
                Amount: part.totalAmount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    UnitPrice: part.sellingPrice,
                    Qty: part.quantity,
                }
            };

            if (part.taxCode) {
                lineItem.SalesItemLineDetail.TaxCodeRef = { value: part.taxCode };
                logger.info(`[processParts] Applied tax code: ${part.taxCode} for part: ${part.name}`);
            }

            lineItems.push(lineItem);
        }
    }

    async processMiscCharges(miscCharges, lineItems) {

        if (!miscCharges) {
            logger.info(`No miscellaneous charges to process.`);
            return;
        }        

        for (const charge of miscCharges) {
            logger.info(`Processing misc charge: ${charge.name}, Amount: ${charge.totalAmount}`);
            const itemId = await this.getItemIdByName(charge.name);
            lineItems.push({
                Amount: charge.totalAmount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    Qty: 1,
                }
            });
        }
    }

    async processDisposalTaxes(disposalTaxes, lineItems) {
        
        if (!disposalTaxes) {
            logger.info(`No disposal Taxes to process.`);
            return;
        } 
        for (const tax of disposalTaxes) {
            logger.info(`Processing disposal Taxes Name: ${tax.name}`);
            const itemId = await this.getItemIdByName(tax.name);
            lineItems.push({
                Amount: tax.totalAmount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    UnitPrice: tax.amount,
                    Qty: 1,
                }
            });
        }
    }

    async createLaborTaxItem() {
        const itemId = await this.getItemIdByName("Labor Tax");
        logger.info("Creating an Labour Tax Item")
        return {
            ItemRef: { value: itemId },
            Qty: 1,
        };
    }

    async buildInvoiceObject(invoicePayload, customer, config, lineItems) {
        const terms = await this.getTermRef(config);
        logger.info(`Creating an Invoice payload`)
        return {
            Line: lineItems,
            CustomerRef: { value: customer[0].Id },
            TxnDate: invoicePayload.invoiceDate,
            TotalAmt: invoicePayload.finalTotal,
            BillAddr: {
                Line1: invoicePayload.from.address.line1,
                City: invoicePayload.from.address.city,
                CountrySubDivisionCode: invoicePayload.from.address.state,
                PostalCode: invoicePayload.from.address.zipcode,
                Country: invoicePayload.from.address.country
            },
            DueDate: invoicePayload.invoiceDate,
            SalesTermRef: { value: terms },
        };
    }

    addTaxDetailsIfNeeded(invoice, invoicePayload) {
        if (invoicePayload.partsTax && invoicePayload.partsTax.length > 0) {
            const { code, name, taxAmount } = invoicePayload.partsTax[0];
            invoice.TxnTaxDetail = {
                // TxnTaxCodeRef: { "value" : code, name },
                TotalTax: taxAmount
            };
        }
    }

    async createInvoiceInQuickBooks(invoice) {
        return new Promise((resolve, reject) => {
            this.qb.createInvoice(invoice, (err, data) => {
                if (err) reject(new Error(`Error creating invoice in QBO: ${err.message}`));
                else resolve(data);
            });
        });
    }

    async validateOrCreateCustomer(customer) {
        try {
            logger.info(`Validating Customer with ${customer.name}`)
            const existingCustomer = await this.getCustomerByName(customer.name);
            return existingCustomer || await this.createNewCustomer(customer);
        } catch (error) {
            logger.error("Error validating or creating customer:", error);
            throw new Error("Failed to validate or create customer.");
        }
    }

    async getCustomerByName(customerName) {
        try {
            logger.info(`Fetching ${customerName} customer info`)
            const data = await new Promise((resolve, reject) => {
                this.qb.findCustomers({ DisplayName: customerName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            return data?.QueryResponse?.Customer;
        } catch (error) {
            logger.error("Error fetching customer data:", error);
            throw new Error("Failed to fetch customer data from QuickBooks Online.");
        }
    }

    async getItemIdByName(itemName) {
        try {
            const findItemsAsync = promisify(this.qb.findItems.bind(this.qb));
            const data = await findItemsAsync({ Name: itemName });

            if (data?.QueryResponse?.Item?.length > 0) {
                return data.QueryResponse.Item[0].Id;
            }else{
                throw new Error(`Item '${itemName}' not found in QuickBooks.`);
        
            }
        } catch (err) {
            logger.error('Error fetching item ID:', err);
            throw new Error(`Error fetching item ID: ${err.message}`);
        }
    }

    async createNewCustomer(customer) {
        const customerPayload = {
            DisplayName: customer.name,
            PrimaryEmailAddr: { Address: customer.email },
            PrimaryPhone: { FreeFormNumber: customer.mobilePhone },
            BillAddr: {
                Line1: customer.address.line1,
                Line2: customer.address.line2,
                City: customer.address.city,
                CountrySubDivisionCode: customer.address.state,
                PostalCode: customer.address.zipcode,
                Country: customer.address.country
            },
            GivenName: customer.firstName || "",
            FamilyName: customer.lastName || "",
        };
        logger.info(`Creation new Customer with name ${customer.name}`)
        try {
            const createdCustomer = await new Promise((resolve, reject) => {
                this.qb.createCustomer(customerPayload, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            logger.info(`Customer '${customer.name}' created successfully`);
            return createdCustomer;
        } catch (error) {
            logger.error("Error creating customer:", error);
            throw new Error("Failed to create new customer in QuickBooks Online.");
        }
    }

    async validateSalesTax(invoice, taxesFromQB) {
        const taxesFromInvoice = this.prepareTaxListForValidation(invoice);
        const activeTaxes = taxesFromQB.filter(tax => tax.Active === true);
        return this.findMismatchedTaxes(taxesFromInvoice, activeTaxes);
    }

    prepareTaxListForValidation(invoice) {
        let taxes = [...invoice.partsTax];
        if (invoice.laborTaxSameAsPart === false && invoice.laborTaxPercentage) {
            taxes.push({
                name: "Labor Tax",
                code: "Labor Tax",
                tax: invoice.laborTaxPercentage,
                taxAmount: invoice.laborTax,
            });
        }
        return taxes;
    }

    findMismatchedTaxes(invoiceTaxes, qbTaxes) {
        return invoiceTaxes.reduce((mismatches, invTax) => {
            logger.info(`Checking mismatched tax: ${invTax.name}, Tax Code: ${invTax.code}`);

            const qbTax = qbTaxes.find(tax => tax.Name === invTax.name);
            
            if (!qbTax) {
                mismatches.push(this.createTaxMismatchObject(invTax, `${invTax.code} not found in QuickBooks.`));
            } else if (parseFloat(invTax.tax) !== parseFloat(qbTax.RateValue)) {
                mismatches.push(this.createTaxMismatchObject(
                    invTax,
                    "Tax rate mismatch between FleetFixy and QuickBooks.",
                    parseFloat(qbTax.RateValue).toFixed(2) + " %"
                ));
            }
            
            return mismatches;
        }, []);
    }

    createTaxMismatchObject(invTax, description, taxInQB = null) {
        return {
            name: invTax.name,
            code: invTax.code,
            tax: parseFloat(invTax.tax).toFixed(2) + " %",
            ...(taxInQB && { taxInQB }),
            description
        };
    }

    async getTermRef(config) {
        try {
            const termName = config.terms;
            logger.info(`Fetching terms for termName ${termName}`)

            if (!termName) {
                throw new Error('No terms specified in config.');
            }

            const terms = await this.getTerm(termName);
            if (!terms || terms.length === 0) {
                throw new Error('No matching Term found between the configuration and QuickBooks.');
            }

            logger.info(`Found term '${termName}' with ID ${terms[0].Id}`);
            return terms[0].Id;
        } catch (error) {
            logger.error("Error in getTermRef:", error);
            throw new Error("Failed to fetch Terms from QuickBooks Online.");
        }
    }

    async getTerm(termName) {
        try {
            const data = await new Promise((resolve, reject) => {
                this.qb.findTerms({ Name: termName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
            logger.info(`Fetching term with Term: ${data}`)
            return data?.QueryResponse?.Term || [];
        } catch (error) {
            logger.error("Error fetching TermRef:", error);
            throw new Error("Failed to fetch TermRef from QuickBooks Online.");
        }
    }

    async getItemAndProcessInvoice(invoice, companyName, customer, config) {
        let invoiceIdToDelete;
        let oldInvoiceFound;

        const oldInvoiceRecord = await RecordDao.findOldInvoiceRecord(invoice.workOrderId, companyName);
        const existingQbInvoiceId = oldInvoiceRecord ? oldInvoiceRecord.invoiceId : invoice.invoiceId;

        if (existingQbInvoiceId) {
            logger.info("Invoice creating again");
            invoiceIdToDelete = await this.determineInvoiceToDelete(oldInvoiceRecord, existingQbInvoiceId, invoice.workOrderId);
        }

        const status = this.determineInvoiceStatus(invoiceIdToDelete, oldInvoiceFound);
        const createdInvoice = await this.createInvoiceInQBO(invoice, customer, config);
        logger.info(`Invoice ${status} with invoiceId: ${createdInvoice.Id}`)

        return await failureRecordDao.insertOrUpdateInDBForSuccess(
            invoice.workOrderId,
            createdInvoice.Id,
            status,
            createdInvoice.TxnDate,
            companyName
        );
    }

    async determineInvoiceToDelete(oldInvoiceRecord, existingQbInvoiceId, workOrderId) {
        if (oldInvoiceRecord && oldInvoiceRecord.DocNumber) {
            logger.info(`Picked invoiceIdToDelete from db: ${oldInvoiceRecord.invoiceId} for workOrderId: ${workOrderId} and qbInvoiceNumber: ${existingQbInvoiceId}`);
            return oldInvoiceRecord.invoiceId;
        }

        const invoiceResponse = await this.getInvoiceById(existingQbInvoiceId);
        return invoiceResponse ? invoiceResponse.Id : null;
    }

    determineInvoiceStatus(invoiceIdToDelete, oldInvoiceFound) {
        if (invoiceIdToDelete) {
            this.deleteInvoieById(invoiceIdToDelete);
            return "UPDATED";
        }
        if (oldInvoiceFound === false) return "OLD INVOICE NOT FOUND";
        if (oldInvoiceFound === undefined) return "CREATED";
        return "DUPLICATE OLD INVOICES FOUND";
    }

    async getInvoiceById(invoiceId) {
        try {
            return await new Promise((resolve, reject) => {
                this.qb.getInvoice(invoiceId, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
        } catch (error) {
            logger.error("Error fetching invoice by ID:", error);
            return null;
        }
    }

    async deleteInvoieById(invoiceId) {
        try {
            logger.info("Deleting old invoice.")
            return await new Promise((resolve, reject) => {
                this.qb.deleteInvoice(invoiceId, (err, data) => {
                    if (err) reject(new Error(`Error deleting invoice in QBO: ${err.message}`));
                    else resolve(data);
                });
            });
        } catch (error) {
            logger.error("Error deleting invoice in QBO:", error);
            return null;
        }
    }

    async createDefaultTax(config) {
        try {
            await this.initializeQuickBooks();
            await this.validateOrCreateTaxCode(qbOnlineConstant.TAX_CODES.ZERO_SALES_TAX_CODE, config);
            await this.validateOrCreateTaxCode(qbOnlineConstant.TAX_CODES.ZERO_NON_SALES_TAX_CODE, config);
        } catch (error) {
            logger.error('Failed to create default Rate and Code', error);
            throw error;
        }
    }

    async validateOrCreateTaxCode(taxCode, config) {
        const existingTaxRate = await this.getSalesTaxCode(taxCode);
        if (!existingTaxRate || existingTaxRate.length === 0) {
            logger.info(`Creating new TaxCode: ${taxCode}`);
            return await this.createNewTaxCode(taxCode, config);
        }
        logger.info(`TaxCode '${taxCode}' already exists.`);
        return existingTaxRate[0].Id;
    }

    async getSalesTaxCode(taxRateName) {
        try {
            const data = await new Promise((resolve, reject) => {
                this.qb.findTaxCodes({ Name: taxRateName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });
            return data?.QueryResponse?.TaxCode || [];
        } catch (error) {
            logger.error('Error fetching TaxCode:', error);
            throw error;
        }
    }

    async createNewTaxCode(code, config) {
        try {
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

            const created = await new Promise((resolve, reject) => {
                this.qb.createTaxService(taxServicePayload, (err, resp) => {
                    if (err) reject(err);
                    else resolve(resp.TaxCode);
                });
            });

            logger.info("Created TaxCode:", created);
            return created.Id;
        } catch (error) {
            logger.error("Error creating TaxCode:", error);
            throw error;
        }
    }

    async getTaxAgencyId(taxAgencyName) {
        try {
            const data = await new Promise((resolve, reject) => {
                this.qb.findTaxAgencies({ Name: taxAgencyName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            const agencies = data?.QueryResponse?.TaxAgency || [];
            if (!agencies.length) {
                throw new Error(`No TaxAgency found with name: ${taxAgencyName}`);
            }
            return agencies[0].Id;
        } catch (error) {
            logger.error('Error fetching TaxAgency:', error);
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