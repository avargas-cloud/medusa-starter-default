/**
 * qb-bridge-client.ts
 *
 * Reusable client for all QuickBooks Bridge API calls.
 * All endpoints, auth, and retry logic live here.
 *
 * Bridge API Reference: docs/QUICKBOOKS_BRIDGE_MEDUSA_API_REFERENCE.md
 */

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"
const DRY_RUN = process.env.QB_DRY_RUN === "true"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QbOrderItem {
    productId: string   // QB ListID of the product
    quantity: number
    price: number       // in dollars (e.g., 29.99)
    desc?: string
}

export interface QbCreateCustomerPayload {
    Name: string         // Built by buildQbCustomerName()
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
    customerName: string  // Must match exactly the QB customer name
    date: string          // "YYYY-MM-DD"
    items: QbOrderItem[]
    templateRef?: string  // Default: "Sales Order Original"
    memo?: string
}

export interface QbReceivePaymentPayload {
    customerName: string
    amount: string          // dollars as string e.g. "29.99"
    paymentMethod: string   // "Visa" | "MasterCard" | "Cash" | etc.
    memo?: string
    autoApply?: boolean     // false = keep as open credit (recommended for e-commerce)
    invoiceId?: string      // if applying to specific invoice
    creditTxnId?: string    // if applying existing credit to invoice
}

export interface QbCreateInvoicePayload {
    customerName: string
    LinkToTxnID: string     // Sales Order TxnID
    templateRef?: string
}

export interface QbBridgeResult<T = any> {
    success: boolean
    data?: T
    dryRun?: boolean
    error?: string
}

// ─── Internal fetch helper ─────────────────────────────────────────────────────

async function bridgeFetch(
    method: "GET" | "POST",
    path: string,
    body?: object
): Promise<any> {
    const url = `${BRIDGE_URL}${path}`

    const res = await fetch(url, {
        method,
        headers: {
            "x-api-key": API_KEY,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`Bridge ${method} ${path} → ${res.status}: ${text}`)
    }

    return res.json()
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
        // Bridge returns the ListID directly or inside a wrapper
        const listId = data?.ListID || data?.listId || data?.id
        if (!listId) throw new Error("Bridge did not return a ListID")
        return { success: true, data: { listId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Sales Orders ──────────────────────────────────────────────────────────────

/**
 * Creates a Sales Order in QuickBooks.
 * Returns the SO TxnID to store in order.metadata.qb_so_txnid
 */
export async function createSalesOrderInQb(
    payload: QbCreateSalesOrderPayload
): Promise<QbBridgeResult<{ txnId: string }>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Sales Order for:`, payload.customerName, `(${payload.items.length} items)`)
        return { success: true, dryRun: true, data: { txnId: "DRY_RUN_TXNID" } }
    }

    try {
        const body = {
            ...payload,
            templateRef: payload.templateRef || "Sales Order Original",
        }
        const data = await bridgeFetch("POST", "/api/sales-orders", body)
        const txnId = data?.TxnID || data?.txnId || data?.id
        if (!txnId) throw new Error("Bridge did not return a TxnID for Sales Order")
        return { success: true, data: { txnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Payments ──────────────────────────────────────────────────────────────────

/**
 * Records a payment receipt in QuickBooks (called when payment is captured).
 * With autoApply: false, creates an unapplied credit that can be applied to the Invoice later.
 * Returns the Payment TxnID.
 */
export async function receivePaymentInQb(
    payload: QbReceivePaymentPayload
): Promise<QbBridgeResult<{ txnId: string }>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would record payment in QB: $${payload.amount} from ${payload.customerName}`)
        return { success: true, dryRun: true, data: { txnId: "DRY_RUN_PAYMENT_TXNID" } }
    }

    try {
        const body = {
            autoApply: false, // default: keep as open credit for e-commerce flow
            ...payload,
        }
        const data = await bridgeFetch("POST", "/api/payments", body)
        const txnId = data?.TxnID || data?.txnId || data?.id
        if (!txnId) throw new Error("Bridge did not return a TxnID for Payment")
        return { success: true, data: { txnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

// ─── Invoices ──────────────────────────────────────────────────────────────────

/**
 * Creates an Invoice in QuickBooks linked to an existing Sales Order.
 * Called when the order is shipped/fulfilled (Draft → Processing transition).
 */
export async function createInvoiceInQb(
    payload: QbCreateInvoicePayload
): Promise<QbBridgeResult<{ txnId: string }>> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would create Invoice in QB linked to SO:`, payload.LinkToTxnID)
        return { success: true, dryRun: true, data: { txnId: "DRY_RUN_INVOICE_TXNID" } }
    }

    try {
        const body = {
            ...payload,
            templateRef: payload.templateRef || "Invoice Ecopowertech",
        }
        const data = await bridgeFetch("POST", "/api/invoices", body)
        const txnId = data?.TxnID || data?.txnId || data?.id
        if (!txnId) throw new Error("Bridge did not return a TxnID for Invoice")
        return { success: true, data: { txnId } }
    } catch (err: any) {
        return { success: false, error: err.message }
    }
}

/**
 * Applies a payment credit to an invoice (closes the accounting loop).
 * Called after createInvoiceInQb(), using the payment TxnID from receivePaymentInQb().
 */
export async function applyPaymentToInvoiceInQb(payload: {
    customerName: string
    amount: string
    invoiceId: string
    creditTxnId: string
}): Promise<QbBridgeResult> {
    if (DRY_RUN) {
        console.log(`[QB DRY RUN] Would apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`)
        return { success: true, dryRun: true }
    }

    try {
        await bridgeFetch("POST", "/api/payments", payload)
        return { success: true }
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
