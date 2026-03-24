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
    CustomerType?: string
    PriceLevel?: string
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
}

export interface QbUpdateSalesOrderPayload {
    txnId: string
    customerId?: string
    customerName?: string
    items: QbOrderItem[]
    memo?: string
    salesTaxCode?: string
    taxExempt?: boolean
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
    paymentMethod: string
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
}

export interface QbUpdateEstimatePayload {
    txnId: string
    items: QbOrderItem[]
    memo?: string
    taxExempt?: boolean
    salesTaxCode?: string
    isActive?: boolean
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

export interface QbAsyncResult {
    operationId: string
    txnId?: string
    refNumber?: string
}

export interface QbBridgeResult<T = any> {
    success: boolean
    data?: T
    dryRun?: boolean
    error?: string
}
