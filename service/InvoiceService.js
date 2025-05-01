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
                true,
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
            const lineItems = await this.prepareLineItems(invoicePayload);
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
            } else {
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


    async checkOrCreateServiceItemsQBO() {
        try {
            const qboServiceItemNames = [
                qbOnlineConstant.itemConstatnts.FIXY_QB,
                qbOnlineConstant.itemConstatnts.PARTS,
                qbOnlineConstant.itemConstatnts.MISC_CHARGES,
                qbOnlineConstant.itemConstatnts.DISPOSAL_TAX,
                qbOnlineConstant.itemConstatnts.LABORS
            ];

            const existingItems = await this.getAllItems({});

            const existingItemNames = new Set(
                existingItems.map(item => item.Name)
            );

            const itemsToCreate = qboServiceItemNames.filter(name => !existingItemNames.has(name));

            logger.info(`Service items to create: ${itemsToCreate}`);

            for (const item of itemsToCreate) {
                await this.createServiceItem(item);
            }

        } catch (error) {
            logger.error("Error in checkOrCreateServiceItemsQBO:", error);
            throw error;
        }
    }

    async getAllItems(criteria) {
        try {
            const findItemsAsync = promisify(this.qb.findItems.bind(this.qb));
            const data = await findItemsAsync(criteria);

            return data.QueryResponse.Item;
        } catch (err) {
            logger.error('Error fetching items ', err);
            throw new Error(`Error fetching items : ${err.message}`);
        }
    }


    async createServiceItem(itemName) {
        logger.info("Creating QBO service items");

        const isLabor = itemName === qbOnlineConstant.itemConstatnts.LABORS;
        const isChild = itemName !== qbOnlineConstant.itemConstatnts.FIXY_QB;

        const accountName = isLabor ? qbOnlineConstant.accounts.SERVICE_INCOME_ACCOUNT : qbOnlineConstant.accounts.PARTS_AND_MATERIALS_ACCOUNT;

        try {
            const account = await this.getAccountIdByName(accountName);
            const taxCode = isChild ? await this.getSalesTaxCode(qbOnlineConstant.TAX_CODES.ZERO_SALES_TAX_CODE) : await this.getSalesTaxCode(qbOnlineConstant.TAX_CODES.ZERO_NON_SALES_TAX_CODE);
            if (account.length <= 0) {
                logger.error(`No account found with name: ${accountName}`);
                throw new Error(`No account found with name: ${accountName}`);
            }
            if (taxCode.length <= 0) {
                logger.error(`No tax code found with name: ${taxCode}`);
                throw new Error(`No tax code found with name: ${taxCode}`);
            }
            const taxCodeId = taxCode[0].Id;
            const accountId = account[0].Id;
            const parentItemId = isChild ? await this.getItemIdByName(qbOnlineConstant.itemConstatnts.FIXY_QB) : null;
            const payload = this.prepareServiceItemPayload(itemName, accountId, accountName, "", isChild, parentItemId, taxCodeId);

            await new Promise((resolve, reject) => {
                this.qb.createItem(payload, (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });

            logger.info(`Created service item '${itemName}' in QBO`);
        } catch (err) {
            logger.error(`Failed to create service item '${itemName}': ${err.message}`);
            throw err;
        }

    }


    prepareServiceItemPayload(itemName, accountId, accountName, desc = "", isChild = false, parentItemId = null, taxCodeId) {
        if (!isChild) {
            // Create Category item
            return {
                Name: itemName,
                Type: "Category"
            };
        }

        // Create Service item with optional parent (subcategory)
        const itemPayload = {
            Name: itemName,
            Type: "Service",
            IncomeAccountRef: {
                value: accountId,
                name: accountName
            },
            Description: desc,
            SalesTaxCodeRef: {
                value: taxCodeId
            },
            SubItem: true,
            ParentRef: {
                value: parentItemId,
                name: qbOnlineConstant.itemConstatnts.FIXY_QB
            }
        };

        return itemPayload;
    }


    async getAccountIdByName(accountName) {
        try {
            const data = await new Promise((resolve, reject) => {
                this.qb.findAccounts({ Name: accountName }, (err, data) => {
                    if (err) reject(err);
                    else resolve(data);
                });
            });

            const accounts = data?.QueryResponse?.Account || [];
            return accounts;
        } catch (error) {
            logger.error('Error fetching account:', error);
            throw error;
        }
    }

    async checkOrCreateIncomeAccounts() {
        const accountsList = [
            qbOnlineConstant.accounts.PARTS_AND_MATERIALS_ACCOUNT,
            qbOnlineConstant.accounts.SERVICE_INCOME_ACCOUNT
        ];

        await Promise.all(accountsList.map(async (accountName) => {
            try {
                const existingAccounts = await this.getAccountIdByName(accountName);

                const accountExists = existingAccounts.length > 0;

                if (!accountExists) {
                    logger.info(`[QBO] Account "${accountName}" not found, creating.`);
                    await this.createIncomeAccount(accountName);
                } else {
                    logger.info(`[QBO] Account "${accountName}" already exists.`);
                }
            } catch (err) {
                logger.error(`[QBO] Error checking/creating account "${accountName}": ${err.message}`);
                throw err;
            }
        }));
    };

    async createIncomeAccount(accountName) {
        logger.info(`[QBO] Creating income account: ${accountName}`);

        const accountPayload = {
            Name: accountName,
            AccountType: 'Income',
            // AccountSubType: 'SalesOfProductIncome', // You can adjust this subtype as needed
            Description: ''
        };

        try {
            await new Promise((resolve, reject) => {
                this.qb.createAccount(accountPayload, (err, result) => {
                    if (err) return reject(err);
                    resolve(result);
                });
            });

            logger.info(`[QBO] Account created successfully: ${accountName}`);
        } catch (err) {
            logger.error(`[QBO] Failed to create account "${accountName}": ${err.message}`);
            throw err;
        }
    };


    async prepareLineItems(invoice) {
        const { parts, miscCharges, labors, disposalTaxes, partTaxName, laboutTaxName} = this.getItems(invoice);
        const lineItems = [];
        const partTaxRef = await this.getSalesTaxCode(partTaxName);
        const partTaxId = partTaxRef[0]?.Id;


        if (parts.length) await this.prepareParts(parts, lineItems, partTaxId);
        if (miscCharges.length) await this.prepareMiscCharges(miscCharges, lineItems, partTaxId);
        if (disposalTaxes.length) await this.prepareDisposalTaxes(disposalTaxes, lineItems, partTaxId);

        if (invoice.laborTaxSameAsPart && labors.length) {
            await this.prepareLabor(labors, lineItems, partTaxId);
        }

        if (!invoice.laborTaxSameAsPart && labors.length) {
            const laboutTax = await this.getSalesTaxCode(laboutTaxName);
            const labourTaxId = laboutTax[0]?.Id;
            await this.prepareLabor(labors, lineItems, labourTaxId);
        }

        return lineItems;
    }

    async createTaxGroup(groupName){
        try {
            const taxGroupPayload = {
                Name: groupName,
                Taxable: true
            };

            const created = await new Promise((resolve, reject) => {
                this.qb.createTaxC(taxGroupPayload, (err, resp) => {
                    if (err) reject(err);
                    else resolve(resp);
                });
            });

            logger.info("Created TaxGroup:", created);
            return created.Id;
        } catch (error) {
            logger.error("Error creating TaxGroup:", error);
            throw error;
        }
    }

    getItems(invoice) {
        const parts = [], labors = [], miscCharges = [], disposalTaxes = [];
        const partTaxName = null, laboutTaxName = null;
        invoice.lines.forEach(line => {
            line.parts.forEach(part => {
                part.name = `${line.item} ${qbOnlineConstant.lineItemConstants.PART} - ${part.name}`;
                parts.push(part);
            });

            line.labors.forEach(labor => {
                labor.name = `${line.item} ${qbOnlineConstant.lineItemConstants.LABOR} - ${labor.name}`;
                labors.push(labor);
            });

            line.miscCharges.forEach(misc => {
                misc.name = `${line.item} ${qbOnlineConstant.lineItemConstants.MISC_CHARGES} - ${misc.name}`;
                miscCharges.push(misc);
            });

            line.disposalFees.forEach(disposal => {
                disposal.name = `${line.item} ${qbOnlineConstant.lineItemConstants.DISPOSAL_TAX} - ${disposal.name}`;
                disposalTaxes.push(disposal);
            });
        });
        partTaxName = invoice.partsTax.map(partTax => partTax.taxCode).join('-');
        laboutTaxName = invoice.laborTax.map(laborTax => laborTax.taxCode).join('-');
        return { parts, labors, miscCharges, disposalTaxes, partTaxName, laboutTaxName};
    }

    async prepareParts(parts, lineItems, saleTax) {
        const itemId = await this.getItemIdByName(qbOnlineConstant.itemConstatnts.PARTS);

        for (const part of parts) {
            lineItems.push({
                Amount: parseFloat(part.sellingPrice) * part.quantity,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    UnitPrice: parseFloat(part.sellingPrice),
                    Qty: part.quantity,
                    TaxCodeRef: { value: saleTax }
                },
                Description: `${part.name} ($ ${parseFloat(part.sellingPrice).toFixed(2)} * ${part.quantity}${part.unit})`
            });
        }
    }

    async prepareMiscCharges(miscCharges, lineItems, zeroTaxCode) {
        const itemId = await this.getItemIdByName(qbOnlineConstant.itemConstatnts.MISC_CHARGES);

        for (const misc of miscCharges) {
            lineItems.push({
                Amount: parseFloat(misc.totalAmount),
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    UnitPrice: parseFloat(misc.totalAmount),
                    Qty: 1,
                    TaxCodeRef: { value: zeroTaxCode }
                },
                Description: misc.name
            });
        }
    }

    async prepareLabor(labors, lineItems, zeroTaxCode) {
        const itemId = await this.getItemIdByName(qbOnlineConstant.itemConstatnts.LABORS);

        for (const labor of labors) {
            const amount = parseFloat(labor.laborPerHour) * labor.hours;
            lineItems.push({
                Amount: amount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    UnitPrice: parseFloat(labor.laborPerHour),
                    Qty: labor.hours,
                    TaxCodeRef: { value: zeroTaxCode }
                },
                Description: `${labor.name} ($${parseFloat(labor.laborPerHour).toFixed(2)} x ${labor.hours} hrs.)`
            });
        }
    }

    async prepareDisposalTaxes(disposalTaxes, lineItems, zeroTaxCode) {
        const itemId = await this.getItemIdByName(qbOnlineConstant.itemConstatnts.DISPOSAL_TAX);

        for (const disposal of disposalTaxes) {
            const amount = parseFloat(disposal.feeAmount) * disposal.quantity;
            lineItems.push({
                Amount: amount,
                DetailType: "SalesItemLineDetail",
                SalesItemLineDetail: {
                    ItemRef: { value: itemId },
                    UnitPrice: parseFloat(disposal.feeAmount),
                    Qty: disposal.quantity,
                    TaxCodeRef: { value: zeroTaxCode }
                },
                Description: `${disposal.name} ($${parseFloat(disposal.feeAmount).toFixed(2)} x ${disposal.quantity} ${disposal.unit})`
            });
        }
    }

    async prepareSubtotal(description, lineItems) {
        const itemId = await this.getItemIdByName(qbOnlineConstant.subTotalConstants.SUB_TOTAL);
        lineItems.push({
            Amount: 0,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                ItemRef: { value: itemId },
                Qty: 1,
                UnitPrice: 0
            },
            Description: description
        });
    }

    async prepareTax(tax, lineItems) {
        const itemId = await this.getItemIdByName(tax.name);
        lineItems.push({
            Amount: 0,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                ItemRef: { value: itemId },
                Qty: 1,
                UnitPrice: 0
            },
            Description: tax.code
        });
    }

    async prepareLaborTax(lineItems) {
        const itemId = await this.getItemIdByName("Labor Tax");
        lineItems.push({
            Amount: 0,
            DetailType: "SalesItemLineDetail",
            SalesItemLineDetail: {
                ItemRef: { value: itemId },
                Qty: 1,
                UnitPrice: 0
            },
            Description: "Labor Tax"
        });
    }


}

module.exports = { InvoiceService };