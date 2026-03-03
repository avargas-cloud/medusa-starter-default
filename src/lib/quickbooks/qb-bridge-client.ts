/**
 * qb-bridge-client.ts
 *
 * Reusable client for all QuickBooks Bridge API calls.
 * All endpoints, auth, polling, and retry logic live here.
 *
 * KEY ARCHITECTURE:
 *   - ALL Bridge write operations are ASYNC. They return { operationId }.
 *   - Poll GET /api/sync/status/{operationId} to get txnId + refNumber.
 *   - ALL endpoints use customerId (QB ListID), NOT customerName.
 *   - refNumber = human-readable QB document number (e.g., E18024527, 6139)
 *
 * Bridge API Reference: docs/QUICKBOOKS_BRIDGE_MEDUSA_API_REFERENCE.md
 */

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const DRY_RUN = process.env.QB_DRY_RUN === "true"

// Polling config
const POLL_INTERVAL_MS = 20_000  // 20 seconds between polls
const MAX_POLL_ATTEMPTS = 20     // ~7 min max wait

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QbOrderItem {
    productId: string   // QB ListID of the product
    quantity: number
    price?: number      // in dollars (e.g., 29.99) — optional, QB uses default if omitted
    unitOfMeasure?: string  // e.g. "each" — prevents QB UOM multiplication when price is set
    desc?: string
}

export interface QbCreateCustomerPayload {
    Name: string         // Unique QB identifier — built by buildQbCustomerName()
    FirstName?: string   // Individual's given name (separate from Name field)
    LastName?: string    // Individual's family name (separate from Name field)
    CompanyName?: string
    Email?: string
    Phone?: string
    BillAddress?: {
        Addr1?: string
        City?: string
        State?: string
        PostalCode?: string
    }
    CustomerType?: string   // "Wholesale" | "Retail" | etc.
    PriceLevel?: string
}

export interface QbCreateSalesOrderPayload {
    customerId: string    // QB ListID of the customer (e.g., "8000004E-1342117388")
    date: string          // "YYYY-MM-DD"
    items: QbOrderItem[]
    templateRef?: string  // Default: "Sales Order Original"
    memo?: string
    poNumber?: string
    refNumber?: string
    taxExempt?: boolean          // true → CustomerSalesTaxCodeRef = "Exempt"
    salesTaxCode?: string        // e.g. "Sale Tax 7%" — overrides customer default
}

export interface QbConvertEstimatePayload {
    estimateTxnId: string  // TxnID of the estimate to convert
    customerId: string     // QB ListID of the customer
    date?: string          // "YYYY-MM-DD"
    items: QbOrderItem[]   // Same items from the estimate (required by Bridge)
    memo?: string
    taxExempt?: boolean          // true → CustomerSalesTaxCodeRef = "Exempt"
    salesTaxCode?: string        // e.g. "Sale Tax 7%" — overrides customer default
}

export interface QbReceivePaymentPayload {
    customerId: string      // QB ListID of the customer
    amount: number | string // dollars (e.g., 25.00 or "25.00")
    paymentMethod: string   // "Credit Card" | "Visa" | "MasterCard" | "Cash" | etc.
    memo?: string
    refNumber?: string      // Custom reference (e.g., "PAY-ord_01JFXYZ")
    autoApply?: boolean     // false = keep as open credit (recommended for e-commerce)
    invoiceId?: string      // if applying to specific invoice
    creditTxnId?: string    // if applying existing credit to invoice
    depositAccount?: string // e.g., "Undeposited Funds"
}

export interface QbCreateInvoicePayload {
    customerId: string      // QB ListID of the customer
    date?: string           // "YYYY-MM-DD"
    LinkToTxnID?: string    // Sales Order TxnID (for linked invoices)
    templateRef?: string
    items?: QbOrderItem[]   // Only needed for standalone invoices (not linked to SO)
}

export interface QbCreateEstimatePayload {
    customerId: string    // QB ListID of the customer (e.g., "8000004E-1342117388")
    date: string          // "YYYY-MM-DD"
    items: QbOrderItem[]
    templateRef?: string
    memo?: string
    poNumber?: string
    refNumber?: string
    taxExempt?: boolean          // true → CustomerSalesTaxCodeRef = "Exempt"
    salesTaxCode?: string        // e.g. "Sale Tax 7%" | "Exempt" | "Out of State"
}

/** Result from any Bridge async operation */
export interface QbAsyncResult {
    operationId: string
    txnId?: string       // Populated after polling — internal QB ID for API calls
    refNumber?: string   // Populated after polling — human-readable (e.g., "E18024527", "6139")
}

export interface QbBridgeResult<T = any> {
    success: boolean
    data?: T
    dryRun?: boolean
    error?: string
}

// ─── Internal fetch helper ─────────────────────────────────────────────────────

async function bridgeFetch(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: object
): Promise<any> {
    const url = `${BRIDGE_URL}${path}`

    const res = await fetch(url, {
        method,
        headers: {
            "x-api-key": API_KEY,
            "Content-Type": "application/json",
            "bypass-tunnel-reminder": "true",
        },
        body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Bridge ${method} ${path} → ${res.status}: ${text}`)
    }

    return res.json()
}

// ─── Async Polling Helper ──────────────────────────────────────────────────────

/**
 * Polls the Bridge for the result of an async operation.
 * Returns txnId + refNumber when the operation completes.
 *
 * @param operationId - The ID returned by any Bridge POST operation
 * @param log - Optional logger function (defaults to console.log)
 * @returns The completed operation data with txnId and refNumber
 * @throws Error if operation fails or times out
 */
export async function pollOperationResult(
    operationId: string,
    log: (msg: string) => void = console.log
): Promise<QbAsyncResult> {
    for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

        log(`[QB] ⏳ Polling operation ${operationId} (${attempt}/${MAX_POLL_ATTEMPTS})...`)

        try {
            const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`)
            const op = statusRes?.operation

            if (!op) continue

            if (op.status === "completed") {
                const txnId = op.txnId || op.result?.TxnID
                const refNumber = op.refNumber || op.result?.RefNumber
                log(`[QB] ✅ Operation completed. TxnID: ${txnId}, RefNumber: ${refNumber}`)
                return { operationId, txnId, refNumber }
            }

            if (op.status === "failed") {
                throw new Error(`QB operation ${operationId} failed: ${op.error || "Unknown error"}`)
            }

            // Still pending/processing — continue polling
            log(`[QB]    Status: ${op.status}`)
        } catch (err: any) {
            if (err.message.includes("failed:")) throw err
            log(`[QB] ⚠️ Poll error (will retry): ${err.message}`)
        }
    }

    // Timed out — return what we have (operationId only)
    log(`[QB] ⏱️ Polling timed out for operation ${operationId} after ${MAX_POLL_ATTEMPTS} attempts`)
    return { operationId }
}

// ─── Health Check ──────────────────────────────────────────────────────────────

export async function checkBridgeHealth(): Promise<boolean> {
    try {
        const data = await bridgeFetch("GET", "/health")
        return data?.status === "healthy"
    } catch {
        return false
    }
}

// ─── Customers ─────────────────────────────────────────────────────────────────

/**
 * Creates a customer in QuickBooks via the Bridge.
 * Customer creation is also async — poll for ListID.
 * Returns the QB ListID to store in customer.metadata.qb_list_id
 */
export async function createCustomerInQb(
    payload: QbCreateCustomerPayload
): Promise<QbBridgeResult<{ listId: string }>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create customer in QB:`, payload.Name)
        return { success: true, dryRun: true, data: { listId: "DRY_RUN_ID" } }
    }

    try {
        const data = await bridgeFetch("POST", "/api/customers", payload)

        // Customer creation may be sync (returns ListID directly) or async (returns operationId)
        const listId = data?.ListID || data?.listId || data?.id
        if (listId) {
            return { success: true, data: { listId } }
        }

        // If async, poll for result
        const operationId = data?.operationId
        if (operationId) {
            const result = await pollOperationResult(operationId)
            const resolvedListId = result.txnId // For customers, txnId is actually the ListID
            if (!resolvedListId) throw new Error("Polling completed but no ListID returned")
            return { success: true, data: { listId: resolvedListId } }
        }

        throw new Error("Bridge did not return a ListID or operationId")
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Sales Orders ──────────────────────────────────────────────────────────────

/**
 * Creates a Sales Order in QuickBooks (async).
 * Returns operationId immediately. Caller can poll for txnId + refNumber.
 */
export async function createSalesOrderInQb(
    payload: QbCreateSalesOrderPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Sales Order for:`, payload.customerId, `(${payload.items.length} items)`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_SO_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            ...payload,
            templateRef: payload.templateRef || "Sales Order Original",
        }
        const data = await bridgeFetch("POST", "/api/sales-orders", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Sales Order")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Converts an existing Estimate into a Sales Order (async).
 * Called when a Draft Order is confirmed → becomes a real Order.
 * NOTE: items[] IS required — Bridge does not auto-copy from estimate.
 */
export async function convertEstimateToSalesOrder(
    payload: QbConvertEstimatePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would convert Estimate ${payload.estimateTxnId} to Sales Order`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_CONVERT_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const data = await bridgeFetch("POST", "/api/sales-orders/convert-from-estimate", payload)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for convert-from-estimate")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Payments ──────────────────────────────────────────────────────────────────

/**
 * Records a payment receipt in QuickBooks (async).
 * With autoApply: false, creates an unapplied credit that can be applied to the Invoice later.
 */
export async function receivePaymentInQb(
    payload: QbReceivePaymentPayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would record payment in QB: $${payload.amount} from ${payload.customerId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_PAYMENT_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            autoApply: false, // default: keep as open credit for e-commerce flow
            ...payload,
        }
        const data = await bridgeFetch("POST", "/api/payments", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Payment")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Applies a payment credit to an invoice (async — closes the accounting loop).
 * Called after createInvoiceInQb(), using the payment TxnID from receivePaymentInQb().
 */
export async function applyPaymentToInvoiceInQb(payload: {
    customerId: string    // QB ListID of the customer
    amount: number | string
    invoiceId: string
    creditTxnId: string
}): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("POST", "/api/payments", payload)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for apply-payment")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Invoices ──────────────────────────────────────────────────────────────────

/**
 * Creates an Invoice in QuickBooks (async).
 * Can be linked to a Sales Order via LinkToTxnID, or standalone with items[].
 */
export async function createInvoiceInQb(
    payload: QbCreateInvoicePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Invoice in QB linked to SO:`, payload.LinkToTxnID || "(standalone)")
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_INVOICE_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            ...payload,
            templateRef: payload.templateRef || "Invoice Ecopowertech",
        }
        const data = await bridgeFetch("POST", "/api/invoices", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Invoice")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Estimates ─────────────────────────────────────────────────────────────────

/**
 * Creates an Estimate in QuickBooks (async — used for Draft Orders).
 * Returns operationId. Poll for txnId (qb_estimate_txn_id) + refNumber (qb_estimate_ref).
 */
export async function createEstimateInQb(
    payload: QbCreateEstimatePayload
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Estimate for:`, payload.customerId, `(${payload.items.length} items)`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN", txnId: "DRY_RUN_ESTIMATE_TXNID", refNumber: "DRY_RUN_REF" } }
    }

    try {
        const body = {
            ...payload,
            templateRef: payload.templateRef || undefined,  // Only send if explicitly set
        }
        const data = await bridgeFetch("POST", "/api/estimates", body)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return an operationId for Estimate")
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Inventory Adjustment ──────────────────────────────────────────────────────

/**
 * Reduces QB inventory when an order is placed (immediate deduction per order).
 * This is separate from the periodic Inventory Sync (which handles PO receipts).
 */
export async function adjustInventoryInQb(items: Array<{
    listId: string    // QB ListID of the product
    quantity: number  // absolute new quantity (not a delta)
}>): Promise<QbBridgeResult> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would adjust inventory for ${items.length} items in QB`)
        return { success: true, dryRun: true }
    }

    try {
        await bridgeFetch("POST", "/api/products/sync", {
            items: items.map(i => ({ ListID: i.listId, quantity: i.quantity }))
        })
        return { success: true }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Void / Cancel / Close ─────────────────────────────────────────────────────

/**
 * Closes a Sales Order in QuickBooks (IsManuallyClosed = true).
 * Called when a Medusa order is cancelled before fulfillment.
 * Requires a two-step flow: GET EditSequence → DELETE (close).
 */
export async function closeSalesOrderInQb(
    soTxnId: string,
    editSequence: string,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would close Sales Order ${soTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("DELETE", `/api/sales-orders/${soTxnId}`, { EditSequence: editSequence })
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Sales Order close")
        log(`[QB] Sales Order ${soTxnId} close queued (op: ${operationId})`)
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Voids an Invoice in QuickBooks (TxnVoidRq — no EditSequence required).
 * Called when a Medusa order is cancelled after invoice was created.
 */
export async function voidInvoiceInQb(
    invoiceTxnId: string,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would void Invoice ${invoiceTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("DELETE", `/api/invoices/${invoiceTxnId}`)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Invoice void")
        log(`[QB] Invoice ${invoiceTxnId} void queued (op: ${operationId})`)
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Cancels an Estimate in QuickBooks (zeros all line quantities via EstimateMod).
 * Called when a Medusa Draft Order is deleted before confirmation.
 *
 * @param estimateTxnId - QB TxnID of the estimate
 * @param editSequence  - Fetch this first via GET /api/estimates/:txnId
 * @param lines         - [{TxnLineID: string}] — from the estimate query result
 */
export async function cancelEstimateInQb(
    estimateTxnId: string,
    editSequence: string,
    lines: Array<{ TxnLineID: string }>,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would cancel Estimate ${estimateTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("DELETE", `/api/estimates/${estimateTxnId}`, {
            EditSequence: editSequence,
            lines,
        })
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Estimate cancel")
        log(`[QB] Estimate ${estimateTxnId} cancel queued (op: ${operationId})`)
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Voids a Sales Receipt in QuickBooks (TxnVoidRq — no EditSequence required).
 * Use case: cancelled in-store sale in the seller admin panel.
 */
export async function voidSalesReceiptInQb(
    receiptTxnId: string,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would void Sales Receipt ${receiptTxnId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const data = await bridgeFetch("DELETE", `/api/sales-receipts/${receiptTxnId}`)
        const operationId = data?.operationId
        if (!operationId) throw new Error("Bridge did not return operationId for Sales Receipt void")
        log(`[QB] Sales Receipt ${receiptTxnId} void queued (op: ${operationId})`)
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Reassigns the customer on a QB document (SO or Invoice).
 * Called when Medusa fires a "Transfer Ownership" on an order.
 *
 * @param docType       - 'sales-order' | 'invoice'
 * @param txnId         - QB TxnID of the document
 * @param editSequence  - Fetch this first via GET /api/<docType>/:txnId
 * @param newCustomerId - New customer QB ListID
 */
export async function transferDocumentCustomer(
    docType: "sales-order" | "invoice",
    txnId: string,
    editSequence: string,
    newCustomerId: string,
    log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
    if (DRY_RUN) {
        log(`[QB DRY RUN] Would transfer ${docType} ${txnId} to customer ${newCustomerId}`)
        return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } }
    }

    try {
        const endpoint = docType === "sales-order" ? "/api/sales-orders" : "/api/invoices"
        const data = await bridgeFetch("PATCH", `${endpoint}/${txnId}/customer`, {
            customerId: newCustomerId,
            EditSequence: editSequence,
        })
        const operationId = data?.operationId
        if (!operationId) throw new Error(`Bridge did not return operationId for ${docType} customer transfer`)
        log(`[QB] ${docType} ${txnId} customer transfer queued → ${newCustomerId} (op: ${operationId})`)
        return { success: true, data: { operationId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}
