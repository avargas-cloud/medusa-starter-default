/**
 * order-flow-core.ts
 *
 * Orchestrates the complete QuickBooks flow for orders in Medusa.
 *
 * ARCHITECTURE:
 *   - All Bridge operations are ASYNC (return operationId).
 *   - We use "fire-and-poll" — queue the op, poll for txnId + refNumber.
 *   - Store BOTH txnId (for API calls) and refNumber (human-readable) in metadata.
 *   - ALL endpoints use customerId (QB ListID), NOT customerName.
 *
 * DISABLED BY DEFAULT: Controlled by QB_ORDER_FLOW_ENABLED env var.
 * DRY RUN: Set QB_DRY_RUN=true to simulate without writing to QuickBooks.
 *
 * Flow (Regular Order):
 *   1. Ensure customer exists in QB → save ListID to customer metadata
 *   2. Create Sales Order in QB → poll → save txnId + refNumber to order metadata
 *
 * Flow (Draft Order → Estimate):
 *   A. Create Estimate → poll → save txnId + refNumber to draft order metadata
 *   B. Convert Estimate → Sales Order → poll → save txnId + refNumber to order metadata
 *
 * Flow (Payment):
 *   3. Receive Payment (unapplied credit) → poll → save txnId + refNumber
 *
 * Flow (Invoice):
 *   4. Create Invoice linked to SO → poll → save txnId + refNumber
 *   5. Apply Payment to Invoice → closes the accounting loop
 *
 * Env vars:
 *   QB_ORDER_FLOW_ENABLED=false   — set to "true" to activate
 *   QB_DRY_RUN=false              — set to "true" to simulate without writing to QB
 */

import { buildQbCustomerName } from "./build-customer-name"
import {
    checkBridgeHealth,
    createCustomerInQb,
    createSalesOrderInQb,
    convertEstimateToSalesOrder,
    receivePaymentInQb,
    createInvoiceInQb,
    createEstimateInQb,
    applyPaymentToInvoiceInQb,
    pollOperationResult,
    QbOrderItem,
} from "./qb-bridge-client"
import { isQbIntegrationEnabled } from "./qb-integration-guard"

const ORDER_FLOW_ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"
const DRY_RUN = process.env.QB_DRY_RUN === "true"

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface MedusaOrderForQb {
    id: string
    display_id?: number
    metadata?: Record<string, any>
    customer?: {
        id: string
        email?: string
        first_name?: string | null
        last_name?: string | null
        company_name?: string | null
        phone?: string | null
        metadata?: Record<string, any>
        addresses?: Array<{
            address_1?: string
            city?: string
            province?: string
            postal_code?: string
        }>
    }
    items?: Array<{
        variant?: {
            sku?: string
            metadata?: Record<string, any>
        }
        product_title?: string
        quantity: number
        unit_price: number   // in cents (Medusa v2)
        metadata?: Record<string, any>
    }>
    created_at?: string | Date
    tax_total?: number   // in cents (Medusa v2) — 0 = tax-exempt order
}

export interface OrderFlowResult {
    enabled: boolean
    dryRun?: boolean
    skipped?: boolean
    skipReason?: string
    customerId?: string          // QB ListID (new or existing)
    operationId?: string         // Bridge async operation ID
    soTxnId?: string             // QB Sales Order TxnID (after polling)
    soRefNumber?: string         // QB Sales Order RefNumber (human-readable)
    error?: string
}

// ─── Shared: Guard Checks ──────────────────────────────────────────────────────

async function runGuards(): Promise<{ pass: boolean; result?: OrderFlowResult }> {
    if (!ORDER_FLOW_ENABLED) {
        return { pass: false, result: { enabled: false, skipped: true, skipReason: "QB_ORDER_FLOW_ENABLED is false" } }
    }
    if (!(await isQbIntegrationEnabled())) {
        return { pass: false, result: { enabled: false, skipped: true, skipReason: "QB integration is disabled globally" } }
    }
    return { pass: true }
}

// ─── Shared: Ensure Customer in QB ─────────────────────────────────────────────

/**
 * Ensures the customer exists in QB. Creates if needed.
 * Returns the QB ListID (existing or newly created).
 */
export async function ensureCustomerInQb(
    customer: NonNullable<MedusaOrderForQb["customer"]>,
    customerModule: any,
    log: (msg: string) => void = console.log
): Promise<{ success: boolean; qbCustomerId?: string; error?: string }> {
    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"
    let qbCustomerId: string = customer.metadata?.qb_list_id

    if (qbCustomerId) {
        log(`${prefix} Customer already in QB: ${qbCustomerId}`)
        return { success: true, qbCustomerId }
    }

    log(`${prefix} Customer ${customer.id} has no qb_list_id — creating in QB...`)

    const billingAddress = customer.addresses?.[0]
    const qbName = buildQbCustomerName(customer)

    const createResult = await createCustomerInQb({
        Name: qbName,
        CompanyName: customer.company_name || undefined,
        Email: customer.email,
        Phone: customer.phone || undefined,
        BillAddress: billingAddress ? {
            Addr1: billingAddress.address_1,
            City: billingAddress.city,
            State: billingAddress.province,
            PostalCode: billingAddress.postal_code,
        } : undefined,
    })

    if (!createResult.success) {
        return { success: false, error: `Customer creation failed: ${createResult.error}` }
    }

    qbCustomerId = createResult.data!.listId

    // Save QB ListID back to Medusa customer metadata (skip on dry run)
    if (!DRY_RUN && qbCustomerId !== "DRY_RUN_ID") {
        try {
            await customerModule.updateCustomers(customer.id, {
                metadata: {
                    ...(customer.metadata || {}),
                    qb_list_id: qbCustomerId,
                }
            })
            log(`${prefix} ✅ Saved qb_list_id="${qbCustomerId}" to customer ${customer.id}`)
        } catch (metaErr: any) {
            console.error(`[QB] ⚠️ Could not save qb_list_id to customer: ${metaErr.message}`)
            // Non-fatal — QB customer was created, just metadata save failed
        }
    }

    return { success: true, qbCustomerId }
}

// ─── Shared: Build QB Items ────────────────────────────────────────────────────

/**
 * Strips characters that break QBXML (error 0x80040400):
 * em-dashes, smart quotes, and other non-ASCII Unicode.
 */
function sanitizeForQb(text: string): string {
    if (!text) return ""
    return text
        .replace(/[\u2013\u2014]/g, "-")   // en/em-dash → hyphen
        .replace(/[\u2018\u2019]/g, "'")   // smart single quotes
        .replace(/[\u201C\u201D]/g, '"')   // smart double quotes
        .replace(/[^\x00-\x7F]/g, "")     // strip remaining non-ASCII
        .trim()
}

/**
 * Converts Medusa order items into QB order items.
 * Filters to only items that have a quickbooks_id in variant.metadata.
 * Sends the actual Medusa price as Rate — requires QB price lists to be disabled.
 * Set variant.metadata.quickbooks_uom (e.g. "each") to prevent QB UOM multiplication.
 */
export function buildQbItems(items: MedusaOrderForQb["items"]): QbOrderItem[] {
    return (items || [])
        .filter(item => item.variant?.metadata?.quickbooks_id)
        .map(item => ({
            productId: item.variant!.metadata!.quickbooks_id as string,
            quantity: item.quantity,
            price: (item.unit_price || 0) / 100,  // cents → dollars (actual price charged)
            unitOfMeasure: (item.variant?.metadata?.quickbooks_uom as string) || undefined,
            desc: sanitizeForQb(
                `${item.product_title || ""}${item.variant?.sku ? ` (${item.variant.sku})` : ""}`
            ),
        }))
}


// ─── 1. Process Order → Sales Order ───────────────────────────────────────────

/**
 * Main orchestrator: Order placed → ensure customer → create Sales Order.
 * Called by the qb-order-subscriber on `order.placed`.
 */
export async function processOrderInQb(
    order: MedusaOrderForQb,
    customerModule: any
): Promise<OrderFlowResult> {
    const guard = await runGuards()
    if (!guard.pass) return guard.result!

    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"
    console.log(`${prefix} Processing order #${order.display_id || order.id} in QuickBooks...`)

    try {
        // 1. Health check
        const healthy = await checkBridgeHealth()
        if (!healthy && !DRY_RUN) {
            console.warn(`[QB] ⚠️ Bridge health check failed. Order #${order.display_id} will NOT be sent to QB.`)
            return { enabled: true, skipped: true, skipReason: "Bridge unreachable" }
        }

        // 2. Ensure customer exists in QB
        const customer = order.customer
        if (!customer) {
            return { enabled: true, skipped: true, skipReason: "Order has no customer data" }
        }

        const custResult = await ensureCustomerInQb(customer, customerModule)
        if (!custResult.success) {
            return { enabled: true, error: custResult.error }
        }
        const qbCustomerId = custResult.qbCustomerId!

        // 3. Build Sales Order items
        const soItems = buildQbItems(order.items)

        if (soItems.length === 0) {
            console.warn(`${prefix} ⚠️ Order #${order.display_id} has no items with quickbooks_id — skipping SO creation`)
            return { enabled: true, dryRun: DRY_RUN, customerId: qbCustomerId, skipReason: "No QB-linked items in order" }
        }

        // 4. Check if this order came from a Draft (has estimate to convert)
        const estimateTxnId = order.metadata?.qb_estimate_txn_id
        const taxExempt = !order.tax_total || order.tax_total === 0
        let soResult

        if (estimateTxnId) {
            // Convert Estimate → Sales Order
            console.log(`${prefix} Order derived from estimate ${estimateTxnId} — converting to Sales Order...`)
            soResult = await convertEstimateToSalesOrder({
                estimateTxnId,
                customerId: qbCustomerId,
                date: getDateString(order.created_at),
                items: soItems,
                taxExempt,
                memo: `Medusa Order #${order.display_id || order.id} — from Estimate ${order.metadata?.qb_estimate_ref || estimateTxnId}`,
            })
        } else {
            // Standalone Sales Order
            const orderDate = getDateString(order.created_at)
            soResult = await createSalesOrderInQb({
                customerId: qbCustomerId,
                date: orderDate,
                items: soItems,
                taxExempt,
                memo: `Medusa Web Order #${order.display_id || order.id}`,
            })
        }

        if (!soResult.success) {
            console.error(`[QB] ❌ Failed to create Sales Order: ${soResult.error}`)
            return { enabled: true, dryRun: DRY_RUN, customerId: qbCustomerId, error: `SO creation failed: ${soResult.error}` }
        }

        const asyncData = soResult.data!
        console.log(`${prefix} ✅ Sales Order queued. OperationID: ${asyncData.operationId}`)

        // 5. Poll for result (txnId + refNumber)
        let txnId = asyncData.txnId
        let refNumber = asyncData.refNumber

        if (!txnId && asyncData.operationId !== "DRY_RUN") {
            try {
                const pollResult = await pollOperationResult(asyncData.operationId)
                txnId = pollResult.txnId
                refNumber = pollResult.refNumber
            } catch (pollErr: any) {
                console.error(`[QB] ⚠️ Polling failed (non-blocking): ${pollErr.message}`)
            }
        }

        if (txnId) {
            console.log(`${prefix} ✅ Sales Order created. TxnID: ${txnId}, Ref: ${refNumber || "pending"}`)
        }

        return {
            enabled: true,
            dryRun: DRY_RUN,
            customerId: qbCustomerId,
            operationId: asyncData.operationId,
            soTxnId: txnId,
            soRefNumber: refNumber,
        }

    } catch (err: any) {
        console.error(`[QB] ❌ Unexpected error in processOrderInQb: ${err.message}`)
        return { enabled: true, error: err.message }
    }
}

// ─── 2. Process Payment Capture ───────────────────────────────────────────────

/**
 * Called when a payment is captured in Medusa.
 * Records the payment in QB as an unapplied credit (Step 2 of the QB flow).
 */
export async function processPaymentCaptureInQb(capture: {
    orderId: string
    orderDisplayId?: number
    amount: number        // in cents (Medusa v2)
    paymentMethod: string // e.g., "Credit Card", "Visa", "MasterCard"
    qbCustomerId: string  // QB ListID of the customer
}): Promise<{ enabled: boolean; operationId?: string; txnId?: string; refNumber?: string; error?: string; skipped?: boolean }> {
    const guard = await runGuards()
    if (!guard.pass) return { enabled: false, skipped: true }

    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"
    const amountDollars = (capture.amount / 100)

    console.log(`${prefix} Recording payment of $${amountDollars.toFixed(2)} for order #${capture.orderDisplayId || capture.orderId}...`)

    const result = await receivePaymentInQb({
        customerId: capture.qbCustomerId,
        amount: amountDollars,
        paymentMethod: capture.paymentMethod,
        refNumber: `PAY-${capture.orderDisplayId || capture.orderId}`,
        memo: `Web Order #${capture.orderDisplayId || capture.orderId}`,
        autoApply: false,
    })

    if (!result.success) {
        console.error(`[QB] ❌ Failed to record payment: ${result.error}`)
        return { enabled: true, error: result.error }
    }

    const asyncData = result.data!
    console.log(`${prefix} ✅ Payment queued. OperationID: ${asyncData.operationId}`)

    // Poll for txnId + refNumber
    let txnId = asyncData.txnId
    let refNumber = asyncData.refNumber

    if (!txnId && asyncData.operationId !== "DRY_RUN") {
        try {
            const pollResult = await pollOperationResult(asyncData.operationId)
            txnId = pollResult.txnId
            refNumber = pollResult.refNumber
        } catch (pollErr: any) {
            console.error(`[QB] ⚠️ Payment polling failed (non-blocking): ${pollErr.message}`)
        }
    }

    if (txnId) {
        console.log(`${prefix} ✅ Payment recorded. TxnID: ${txnId}, Ref: ${refNumber || "pending"}`)
    }

    return { enabled: true, operationId: asyncData.operationId, txnId, refNumber }
}

// ─── 3. Process Invoice (Fulfillment) ─────────────────────────────────────────

/**
 * Called when an order is fulfilled/shipped.
 * Creates an Invoice in QB linked to the Sales Order, then applies the payment credit.
 */
export async function processInvoiceInQb(invoice: {
    orderId: string
    orderDisplayId?: number
    qbCustomerId: string
    qbSoTxnId: string          // Sales Order TxnID to link
    qbPaymentTxnId?: string    // Payment TxnID to apply
    paymentAmount?: number     // in cents (Medusa v2)
}): Promise<{ enabled: boolean; operationId?: string; txnId?: string; refNumber?: string; error?: string; skipped?: boolean }> {
    const guard = await runGuards()
    if (!guard.pass) return { enabled: false, skipped: true }

    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"

    // Step 1: Create Invoice linked to Sales Order
    console.log(`${prefix} Creating Invoice for order #${invoice.orderDisplayId || invoice.orderId} linked to SO: ${invoice.qbSoTxnId}...`)

    const invResult = await createInvoiceInQb({
        customerId: invoice.qbCustomerId,
        date: getDateString(),
        LinkToTxnID: invoice.qbSoTxnId,
    })

    if (!invResult.success) {
        console.error(`[QB] ❌ Failed to create Invoice: ${invResult.error}`)
        return { enabled: true, error: invResult.error }
    }

    const asyncData = invResult.data!
    console.log(`${prefix} ✅ Invoice queued. OperationID: ${asyncData.operationId}`)

    // Poll for Invoice txnId + refNumber
    let invTxnId = asyncData.txnId
    let invRefNumber = asyncData.refNumber

    if (!invTxnId && asyncData.operationId !== "DRY_RUN") {
        try {
            const pollResult = await pollOperationResult(asyncData.operationId)
            invTxnId = pollResult.txnId
            invRefNumber = pollResult.refNumber
        } catch (pollErr: any) {
            console.error(`[QB] ⚠️ Invoice polling failed (non-blocking): ${pollErr.message}`)
        }
    }

    if (invTxnId) {
        console.log(`${prefix} ✅ Invoice created. TxnID: ${invTxnId}, Ref: ${invRefNumber || "pending"}`)
    }

    // Step 2: Apply Payment to Invoice (if we have both IDs)
    if (invTxnId && invoice.qbPaymentTxnId && invoice.paymentAmount) {
        console.log(`${prefix} Applying payment ${invoice.qbPaymentTxnId} to invoice ${invTxnId}...`)

        const applyResult = await applyPaymentToInvoiceInQb({
            customerId: invoice.qbCustomerId,
            amount: (invoice.paymentAmount / 100),
            invoiceId: invTxnId,
            creditTxnId: invoice.qbPaymentTxnId,
        })

        if (!applyResult.success) {
            console.error(`[QB] ⚠️ Failed to apply payment to invoice (non-blocking): ${applyResult.error}`)
        } else {
            console.log(`${prefix} ✅ Payment applied to Invoice.`)
        }
    }

    return { enabled: true, operationId: asyncData.operationId, txnId: invTxnId, refNumber: invRefNumber }
}

// ─── 4. Process Estimate (Draft Order) ────────────────────────────────────────

/**
 * Called when a Draft Order is created in Medusa Admin.
 * Creates an Estimate in QB for the draft.
 */
export async function processEstimateInQb(draft: {
    draftOrderId: string
    qbCustomerId: string
    items: QbOrderItem[]
    memo?: string
    date?: string
}): Promise<{ enabled: boolean; operationId?: string; txnId?: string; refNumber?: string; error?: string; skipped?: boolean }> {
    const guard = await runGuards()
    if (!guard.pass) return { enabled: false, skipped: true }

    const prefix = DRY_RUN ? "[QB DRY RUN]" : "[QB]"
    console.log(`${prefix} Creating Estimate for draft order ${draft.draftOrderId}...`)

    if (draft.items.length === 0) {
        console.warn(`${prefix} ⚠️ Draft order has no QB-linked items — skipping Estimate`)
        return { enabled: true, skipped: true }
    }

    const estResult = await createEstimateInQb({
        customerId: draft.qbCustomerId,
        date: draft.date || getDateString(),
        items: draft.items,
        memo: draft.memo || `Draft Order ${draft.draftOrderId}`,
    })

    if (!estResult.success) {
        console.error(`[QB] ❌ Failed to create Estimate: ${estResult.error}`)
        return { enabled: true, error: estResult.error }
    }

    const asyncData = estResult.data!
    console.log(`${prefix} ✅ Estimate queued. OperationID: ${asyncData.operationId}`)

    // Poll for txnId + refNumber
    let txnId = asyncData.txnId
    let refNumber = asyncData.refNumber

    if (!txnId && asyncData.operationId !== "DRY_RUN") {
        try {
            const pollResult = await pollOperationResult(asyncData.operationId)
            txnId = pollResult.txnId
            refNumber = pollResult.refNumber
        } catch (pollErr: any) {
            console.error(`[QB] ⚠️ Estimate polling failed (non-blocking): ${pollErr.message}`)
        }
    }

    if (txnId) {
        console.log(`${prefix} ✅ Estimate created. TxnID: ${txnId}, Ref: ${refNumber || "pending"}`)
    }

    return { enabled: true, operationId: asyncData.operationId, txnId, refNumber }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function getDateString(date?: string | Date): string {
    if (date) {
        return new Date(date).toISOString().split("T")[0] as string
    }
    return new Date().toISOString().split("T")[0] as string
}
