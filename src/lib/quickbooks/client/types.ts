// ─── Types ────────────────────────────────────────────────────────────────────

export interface QbOrderItem {
    productId?: string
    productName?: string
    quantity?: number
    price?: number
    amount?: number
    unitOfMeasure?: string
    desc?: string
    noSite?: boolean
}

export interface QbCreateCustomerPayload {
    Name: string
    FirstName?: string
    LastName?: string
    CompanyName?: string
    Email?: string
    Phone?: string
    BillAddress?: {
        Addr1?: string
        City?: string
        State?: string
        PostalCode?: string
    }
    ShipAddress?: {
        Addr1?: string
        City?: string
        State?: string
        PostalCode?: string
    }
    CustomerType?: string
    PriceLevel?: string
    AltContact?: string  // Native QB "Alt. Contact" field (Address Info tab)
    AltPhone?: string    // Native QB "Alt. Phone" field (Address Info tab)
    // Note: Cc is NOT valid in QBXML 10.0 — stored in Medusa metadata only
}

export interface QbUpdateCustomerPayload extends Omit<QbCreateCustomerPayload, 'Name'> {
    Name: string        // QB customer name (must match existing record)
    ListID: string      // QB ListID from metadata.qb_list_id
    EditSequence: string // QB EditSequence (obtained via CustomerQuery)
}

export interface QbCreateSalesOrderPayload {
    customerId: string
    date: string
    items: QbOrderItem[]
    templateRef?: string
    memo?: string
    poNumber?: string
    refNumber?: string
    taxExempt?: boolean
    salesTaxCode?: string
    salesRep?: string
}

export interface QbUpdateSalesOrderPayload {
    txnId: string
    customerId?: string
    customerName?: string
    items: QbOrderItem[]
    memo?: string
    salesTaxCode?: string
    taxExempt?: boolean
    salesRep?: string
}

export interface QbConvertEstimatePayload {
    estimateTxnId: string
    customerId: string
    date?: string
    items: QbOrderItem[]
    memo?: string
    taxExempt?: boolean
    salesTaxCode?: string
}

export interface QbReceivePaymentPayload {
    customerId: string
    amount: number | string
    paymentMethod?: string
    memo?: string
    refNumber?: string
    autoApply?: boolean
    invoiceId?: string
    creditTxnId?: string
    depositAccount?: string
}

export interface QbCreateInvoicePayload {
    customerId: string
    date?: string
    LinkToTxnID?: string
    refNumber?: string
    templateRef?: string
    memo?: string
    items?: QbOrderItem[]
    taxExempt?: boolean
    salesTaxCode?: string
    salesRep?: string
}

export interface QbCreateCreditMemoPayload {
    customerId: string
    date?: string
    refNumber?: string
    memo?: string
    items?: QbOrderItem[]
    taxExempt?: boolean
    salesTaxCode?: string
}

export interface QbUpdateInvoicePayload {
    txnId: string
    salesRep?: string
}

export interface QbUpdateSalesReceiptPayload {
    txnId: string
    salesRep?: string
}

export interface QbCreateEstimatePayload {
    customerId: string
    date: string
    items: QbOrderItem[]
    templateRef?: string
    memo?: string
    poNumber?: string
    refNumber?: string
    taxExempt?: boolean
    salesTaxCode?: string
    salesRep?: string
}

export interface QbUpdateEstimatePayload {
    txnId: string
    items: QbOrderItem[]
    memo?: string
    taxExempt?: boolean
    salesTaxCode?: string
    isActive?: boolean
    salesRep?: string
}

export interface QbCreateSalesReceiptPayload {
    customerId: string
    refNumber?: string
    items: QbOrderItem[]
    paymentMethod?: string
    salesRep?: string
    salesTaxCode?: string
    date?: string
    memo?: string
}

export interface QbCreateCheckPayload {
    customerId: string          // QB ListID of the customer (payee)
    bankAccountListId: string   // QB ListID of the bank account to draw from
    amount: number              // dollars (not cents)
    date?: string               // ISO date string (YYYY-MM-DD)
    refNumber?: string          // human-readable reference (e.g. "CM-20045")
    memo?: string               // check memo
    expenseAccountName?: string // QB FullName of expense account (default: "Accounts Receivable")
}

export interface QbAsyncResult {
    operationId: string
    txnId?: string
    refNumber?: string
    listId?: string      // Customer operations return listId (QB ListID) instead of txnId
    editSequence?: string
}

export interface QbBridgeResult<T = any> {
    success: boolean
    data?: T
    dryRun?: boolean
    error?: string
}
