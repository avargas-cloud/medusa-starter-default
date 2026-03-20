/**
 * qb-order-subscriber.ts
 *
 * Event-driven subscriber that connects Medusa order lifecycle events
 * to QuickBooks operations via the Bridge.
 *
 * Events handled:
 *   - order.placed           → Create Sales Order (or convert from Estimate)
 *   - order.payment_captured → Receive Payment (unapplied credit)
 *   - order.fulfillment_created → Create Invoice + Apply Payment
 *   - order.canceled         → Void Invoice / Close Sales Order
 *   - order.customer_transferred → Reassign QB documents to new customer
 *
 * DISABLED BY DEFAULT: Set QB_ORDER_FLOW_ENABLED=true to activate.
 * QB failures NEVER block the Medusa flow.
 *
 * POS SKIP: Orders placed through the POS Sales Channel are skipped.
 *   The POS app handles QB sync directly (Sales Receipt or SO) without this subscriber.
 *   Set QB_POS_SALES_CHANNEL_ID env var to the POS channel's ID to enable this guard.
 *   No metadata needed — sales_channel_id is a native Medusa column on the order.
 *
 * Metadata stored on order (new structured JSON shape):
 *   qb_sales_order: { ref_number, txn_id, operation_id, synced_at }
 *   qb_invoices:    [{ ref_number, txn_id, operation_id, fulfillment_id, synced_at }]
 *   qb_payments:    [{ ref_number, txn_id, operation_id, amount, method, synced_at }]
 *   qb_sync_status: "sales_order" | "estimate_conversion" | "pending" | null
 *   qb_list_id, qb_synced_at (flat, unchanged)
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import {
    processOrderInQb,
    processPaymentCaptureInQb,
    processInvoiceInQb,
    buildQbItems,
    buildShippingQbItem,
    buildQbOrderDiscountLines,
} from "../lib/quickbooks/order-flow-core"
import {
    closeSalesOrderInQb,
    voidInvoiceInQb,
    transferDocumentCustomer,
} from "../lib/quickbooks/qb-bridge-client"
import { QbSyncLogger } from "../lib/quickbooks/qb-sync-logger"
import {
    buildSaleOrderPatch,
    buildInvoicePatch,
    buildPaymentPatch,
    getEstimateTxnId,
    getSoTxnId,
    getSoRef,
    getSoOperationId,
    getLatestInvoiceTxnId,
    getLatestInvoiceRef,
    getLatestPaymentTxnId,
} from "../lib/quickbooks/qb-metadata-types"

const LOG_PREFIX = "[QB-ORDER]"
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"

// Sales Channel IDs from .env
// POS orders skip the subscriber — the POS app calls the QB bridge directly.
// Web Store orders go through the subscriber as usual.
const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID ?? ""
// const WEB_STORE_CHANNEL_ID = process.env.WEB_STORE_SALES_CHANNEL_ID ?? ""  // available for future use

/** Returns true if the order was placed through the POS sales channel */
function isPosOrder(order: any): boolean {
    // Primary check: sales channel ID (set via POS_SALES_CHANNEL_ID env var)
    if (POS_CHANNEL_ID && order.sales_channel_id === POS_CHANNEL_ID) return true
    // Fallback: metadata flag set by POS app on all orders (works without env var)
    if (order.metadata?.pos_created === true) return true
    return false
}

/**
 * In-memory mutex for order.placed idempotency.
 *
 * JavaScript is single-threaded — has() + add() execute atomically before
 * the first `await`, making it impossible for two concurrent handlers to
 * both pass this check for the same orderId in the same process.
 *
 * Works in combination with the metadata guards (operationId + txnId)
 * which survive process restarts.
 */
const processingOrders = new Set<string>()

// Lightweight QB config reader — uses env vars directly (no DB query needed in subscriber)
// DB-based config is used by the manual sync route (/admin/quickbooks/order) which has pg available
function getQbConfig(): { shippingItemId: string; defaultSalesTaxCode: string } {
    return {
        shippingItemId: process.env.QB_SHIPPING_ITEM_ID || "800006A3-1395258131",
        defaultSalesTaxCode: process.env.QB_DEFAULT_SALES_TAX_CODE || "Sale Tax 7%",
    }
}

// ─── Subscriber Handler ─────────────────────────────────────────────────────

async function qbOrderSubscriber({ event, container }: SubscriberArgs<any>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const orderModule = container.resolve(Modules.ORDER)
    const customerModule = container.resolve(Modules.CUSTOMER)

    // ── Guard: feature flag ──────────────────────────────────────────────────
    if (!ENABLED) {
        logger.info(`${LOG_PREFIX} ⏭️ QB_ORDER_FLOW_ENABLED=false — skipping ${event.name}`)
        return
    }

    logger.info(`${LOG_PREFIX} 📥 Received event: ${event.name} | data: ${JSON.stringify(event.data)}`)

    try {
        switch (event.name) {
            case "order.placed":
                await handleOrderPlaced(event.data, orderModule, customerModule, container, logger)
                break
            case "order.payment_captured":
                await handlePaymentCaptured(event.data, orderModule, customerModule, logger)
                break
            case "order.fulfillment_created":
                await handleFulfillmentCreated(event.data, orderModule, customerModule, container, logger)
                break
            case "order.canceled":
                await handleOrderCanceled(event.data, orderModule, logger)
                break
            case "order.customer_transferred":
                await handleCustomerTransferred(event.data, orderModule, logger)
                break
            default:
                logger.warn(`${LOG_PREFIX} Unhandled event: ${event.name}`)
        }
    } catch (err: any) {
        // QB failures must NEVER block the Medusa flow
        logger.error(`${LOG_PREFIX} ❌ Unhandled exception in ${event.name}: ${err.message}`)
        logger.error(`${LOG_PREFIX} Stack: ${err.stack}`)
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

export async function handleOrderPlaced(
    data: any,
    orderModule: any,
    customerModule: any,
    _container: any,
    logger: any,
    isCron: boolean = false
) {
    const orderId = data.id
    logger.info(`${LOG_PREFIX} ── order.placed → ${orderId} ──`)

    // Read QB config (shipping item ID + sales tax code)
    const qbConfig = await getQbConfig()

    // Fetch full order via Admin HTTP API (same as manual sync button).
    // This is the only way to get shipping_methods and fully enriched variant metadata
    // in a single call. orderModule.retrieveOrder() cannot expand shipping_methods.
    // Fetch full order via internal Query Service
    // This is robust, does not require HTTP auth, and resolves cross-module relations.
    let order: any
    try {
        const query = _container.resolve(ContainerRegistrationKeys.QUERY)
        const { data: [fetchedOrder] } = await query.graph({
            entity: "order",
            fields: [
                "id", "display_id", "status", "metadata", "tax_total",
                "sales_channel_id",        // ← used for POS channel guard
                "customer_id",
                "subtotal",
                "discount_total",
                "promotions.*",
                "promotions.application_method.*",
                "items.*",
                "items.item.unit_price",   // ← canonical price from order_line_item table
                "items.variant.*",
                "items.variant.metadata",
                "customer.*",
                "customer.metadata",
                "shipping_methods.*"
            ],
            filters: { id: orderId }
        })

        if (!fetchedOrder) {
            throw new Error(`Query returned no order for id ${orderId}`)
        }
        order = fetchedOrder
        logger.info(`${LOG_PREFIX} Order fetched via Query: #${order.display_id}, items=${order.items?.length ?? 0}, shipping_methods=${order.shipping_methods?.length ?? 0}, sales_channel_id=${order.sales_channel_id ?? "none"}`)

        // ── POS guard: Delay QB Sales Order creation by 1 hour (handled by cron job) ────
        if (!isCron && isPosOrder(order)) {
            logger.info(`${LOG_PREFIX} ⏭️ POS order (channel: ${order.sales_channel_id}) — Sales Order creation delayed by 1 hour (handled by cron), skipping immediate sync`)
            return
        }

        // DEBUG LOG TO INSPECT VARIANT STRUCTURE
        if (order.items && order.items[0]) {
            logger.info(`${LOG_PREFIX} DEBUG: First item variant: ${JSON.stringify(order.items[0].variant)}`)
        }
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId} via Query: ${err.message}`)
        return
    }

    logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)

    // ── Idempotency guard — 3 layers ─────────────────────────────────────────
    // Layer 1: In-memory mutex (same process, concurrent events)
    //   Atomic in JS single-threaded runtime — zero race window.
    if (processingOrders.has(orderId)) {
        logger.info(`${LOG_PREFIX} ⏭️ Already processing ${orderId} in this process — skipping duplicate`)
        return
    }
    processingOrders.add(orderId)

    try {

        // Layer 2: txnId in metadata → QBWC already processed the SO (supports both old and new shape)
        const existingSoTxnId = getSoTxnId(order.metadata)
        if (existingSoTxnId) {
            logger.info(`${LOG_PREFIX} ⏭️ QB SO already exists (txnId=${existingSoTxnId}) — skipping duplicate`)
            return
        }
        // Layer 3: operationId in metadata → SO already queued (QBWC processing in progress)
        const existingSoOpId = getSoOperationId(order.metadata)
        if (existingSoOpId) {
            logger.info(`${LOG_PREFIX} ⏭️ QB SO already queued (opId=${existingSoOpId}) — skipping duplicate`)
            return
        }

        // Check for draft→order path (estimate metadata on order, supports both shapes)
        const estimateTxnId = getEstimateTxnId(order.metadata)
        if (estimateTxnId) {
            logger.info(`${LOG_PREFIX} ✅ Order has qb_estimate_txn_id=${estimateTxnId} — will convert Estimate→SO`)
        } else {
            logger.info(`${LOG_PREFIX} ℹ️ No qb_estimate_txn_id — direct order path (will check customer)`)
        }

        // Fetch customer separately if not embedded in order
        let customer = (order as any).customer ?? null
        if (!customer && order.customer_id) {
            try {
                customer = await customerModule.retrieveCustomer(order.customer_id, {
                    relations: ["addresses"],
                })
                logger.info(`${LOG_PREFIX} Customer fetched separately: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`)
            } catch (custErr: any) {
                logger.warn(`${LOG_PREFIX} ⚠️ Could not fetch customer ${order.customer_id}: ${custErr.message}`)
            }
        } else if (customer) {
            logger.info(`${LOG_PREFIX} Customer embedded: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`)
        } else {
            logger.warn(`${LOG_PREFIX} ⚠️ Order ${orderId} has no customer_id`)
        }

        // ── Discount strategy ─────────────────────────────────────────────────
        // ALL DISCOUNTS → keep original item prices + Subtotal + Discount lines.
        // QB must show the discount as a separate line at the bottom, not via reduced unit prices.
        const orderDiscountTotal = Math.round((order.discount_total || 0) * 100) // dollars → cents

        const activeItems = (order.items || [])
            .filter((item: any) => (item.quantity ?? 0) > 0)
            .map((item: any) => ({
                ...item,
                unit_price: Math.round((item.unit_price || 0) * 100), // dollars → cents for buildQbItems
                subtotal: undefined, // Force buildQbItems to use original unit_price, ignore item-level discounts
            }))

        const qbItems = buildQbItems(activeItems, order.metadata)

        // Append Subtotal + Discount lines BEFORE shipping so the Subtotal only sums products.
        // Shipping goes LAST — outside the Subtotal — so it's never included in the discount.
        if (orderDiscountTotal > 0) {
            const orderSubtotal = Math.round((order.subtotal || 0) * 100) // dollars → cents
            const discountPercent = orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null
            buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(l => qbItems.push(l))
            logger.info(`${LOG_PREFIX} Discount lines added: -$${(orderDiscountTotal/100).toFixed(2)}`)
        }

        // Add shipping LAST (skip pickup methods automatically) — after Subtotal+Discount
        const shippingItem = buildShippingQbItem(
            (order as any).shipping_methods || [],
            qbConfig.shippingItemId
        )
        if (shippingItem) {
            qbItems.push(shippingItem)
            logger.info(`${LOG_PREFIX} Shipping line added: $${shippingItem.price?.toFixed(2)} (${shippingItem.desc})`)
        } else {
            logger.info(`${LOG_PREFIX} No shipping line (pickup or $0)`)
        }

        // Determine sales tax code
        const hasTax = order.tax_total && order.tax_total > 0
        const salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined
        logger.info(`${LOG_PREFIX} tax_total=${order.tax_total} → salesTaxCode=${salesTaxCode ?? "Exempt (none passed)"}`)

        const orderWithCustomer = { ...order, customer, items: activeItems }

        const result = await processOrderInQb(orderWithCustomer, customerModule, {
            prebuiltItems: qbItems,          // products + shipping (already built above)
            salesTaxCode,                    // "Sale Tax 7%" or undefined (→ Exempt)
        })

        if (result.skipped) {
            logger.info(`${LOG_PREFIX} ⏭️ Skipped: ${result.skipReason}`)
            return
        }
        if (!result.enabled) {
            logger.info(`${LOG_PREFIX} ⏭️ QB disabled: ${result.skipReason}`)
            return
        }
        if (result.error) {
            logger.error(`${LOG_PREFIX} ❌ processOrderInQb error: ${result.error}`)
            return
        }

        // Save QB metadata to order (new structured JSON shape)
        if (result.soTxnId || result.operationId) {
            try {
                const syncStatus = estimateTxnId ? "estimate_conversion" : "sales_order"
                const patch = buildSaleOrderPatch(order.metadata || {}, {
                    txnId:       result.soTxnId || null,
                    refNumber:   result.soRefNumber || null,
                    operationId: result.operationId || null,
                    customerId:  result.customerId || null,
                    syncStatus,
                })
                await orderModule.updateOrders(orderId, { metadata: patch })
                logger.info(`${LOG_PREFIX} ✅ Saved SO metadata — TxnID=${result.soTxnId}, Ref=${result.soRefNumber}, OpID=${result.operationId}, status=${syncStatus}`)
            } catch (metaErr: any) {
                logger.error(`${LOG_PREFIX} ⚠️ Failed to save order metadata: ${metaErr.message}`)
            }
        } else {
            logger.warn(`${LOG_PREFIX} ⚠️ No soTxnId or operationId returned — QB document may not have been created`)
        }

    } finally {
        // Always release the in-memory lock so the orderId can be processed
        // again if needed (e.g., after a manual force-resync).
        processingOrders.delete(orderId)
    }
}

async function handlePaymentCaptured(
    data: any,
    orderModule: any,
    customerModule: any,
    logger: any
) {
    const orderId = data.id || data.order_id
    logger.info(`${LOG_PREFIX} ── order.payment_captured → orderId=${orderId} ──`)
    logger.info(`${LOG_PREFIX} Payment event data: ${JSON.stringify(data)}`)

    let order: any
    try {
        order = await orderModule.retrieveOrder(orderId)
        logger.info(`${LOG_PREFIX} Order fetched: #${order.display_id}, customer_id=${order.customer_id}`)
        logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

    // Note: We no longer guard against isPosOrder here because POS payments
    // should sync to QB immediately (Standalone Invoice + Payment flow).

    // --- FIX: qb_list_id lookup priority ---
    // 1. Stored directly on order.metadata (set by handleOrderPlaced)
    // 2. Fetch customer and use their metadata.qb_list_id
    let qbCustomerId: string | undefined = order.metadata?.qb_list_id

    if (!qbCustomerId && order.customer_id) {
        logger.info(`${LOG_PREFIX} qb_list_id not in order.metadata — fetching customer ${order.customer_id}...`)
        try {
            const customer = await customerModule.retrieveCustomer(order.customer_id)
            qbCustomerId = customer.metadata?.qb_list_id
            logger.info(`${LOG_PREFIX} Customer metadata: ${JSON.stringify(customer.metadata || {})}`)
        } catch (custErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not fetch customer: ${custErr.message}`)
        }
    }

    if (!qbCustomerId) {
        logger.warn(`${LOG_PREFIX} ❌ No qb_list_id found for order ${orderId} — QB Sales Order must exist first. Skipping payment.`)
        logger.warn(`${LOG_PREFIX} This usually means order.placed failed or the QB SO was not yet created.`)
        return
    }

    logger.info(`${LOG_PREFIX} Using qb_list_id=${qbCustomerId}`)

    // Determine payment amount
    const amount = data.amount ?? order.total ?? 0
    logger.info(`${LOG_PREFIX} Payment amount: ${amount} (cents) = $${(amount / 100).toFixed(2)}`)

    const paymentMethod = "Credit Card" // TODO: map from Medusa payment provider

    const result = await processPaymentCaptureInQb({
        orderId,
        orderDisplayId: order.display_id,
        amount,
        paymentMethod,
        qbCustomerId,
    })

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} ⏭️ Payment skipped (QB disabled)`)
        return
    }
    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ processPaymentCaptureInQb error: ${result.error}`)
        return
    }

    // Save payment metadata (new structured JSON shape — appends to qb_payments array)
    if (result.txnId || result.operationId) {
        try {
            const baseMeta = { ...(order.metadata || {}), qb_list_id: qbCustomerId }
            const patch = buildPaymentPatch(baseMeta, {
                txnId:       result.txnId || null,
                refNumber:   result.refNumber || null,
                operationId: result.operationId || null,
                amount,
                method:      paymentMethod,
            })
            await orderModule.updateOrders(orderId, { metadata: patch })
            logger.info(`${LOG_PREFIX} ✅ Saved payment metadata — TxnID=${result.txnId}, Ref=${result.refNumber}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save payment metadata: ${metaErr.message}`)
        }
    }
}

async function handleFulfillmentCreated(
    data: any,
    orderModule: any,
    customerModule: any,
    _container: any,
    logger: any
) {
    const orderId = data.order_id || data.id
    logger.info(`${LOG_PREFIX} ── order.fulfillment_created → orderId=${orderId} ──`)
    logger.info(`${LOG_PREFIX} Fulfillment event data: ${JSON.stringify(data)}`)

    let order: any
    try {
        const query = _container.resolve(ContainerRegistrationKeys.QUERY)
        const { data: [fetchedOrder] } = await query.graph({
            entity: "order",
            fields: [
                "id", "display_id", "status", "metadata", "tax_total", "total",
                "sales_channel_id",
                "customer_id",
                "subtotal",
                "discount_total",
                "promotions.*",
                "promotions.application_method.*",
                "items.*",
                "items.item.unit_price",
                "items.variant.*",
                "items.variant.metadata",
                "customer.*",
                "customer.metadata",
                "shipping_methods.*"
            ],
            filters: { id: orderId }
        })

        if (!fetchedOrder) throw new Error(`Query returned no order for id ${orderId}`)
        order = fetchedOrder
        logger.info(`${LOG_PREFIX} Order fetched for Invoice: #${order.display_id}, customer_id=${order.customer_id}`)
        logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

    // Note: We no longer guard against isPosOrder here because POS fulfillments
    // should sync to QB immediately (Standalone Invoice flow).

    // --- FIX: qb_list_id lookup with customer fallback ---
    let qbCustomerId: string | undefined = order.metadata?.qb_list_id

    if (!qbCustomerId && order.customer_id) {
        logger.info(`${LOG_PREFIX} qb_list_id not in order.metadata — fetching customer ${order.customer_id}...`)
        try {
            const customer = await customerModule.retrieveCustomer(order.customer_id)
            qbCustomerId = customer.metadata?.qb_list_id
            logger.info(`${LOG_PREFIX} Customer metadata: ${JSON.stringify(customer.metadata || {})}`)
        } catch (custErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not fetch customer: ${custErr.message}`)
        }
    }

    // Read via compat helpers — supports both old flat fields and new JSON shape
    let qbSoTxnId: string | undefined = getSoTxnId(order.metadata)
    const qbPaymentTxnId: string | undefined = getLatestPaymentTxnId(order.metadata)

    logger.info(`${LOG_PREFIX} QB data — customerId=${qbCustomerId ?? "MISSING"}, soTxnId=${qbSoTxnId ?? "MISSING"}, paymentTxnId=${qbPaymentTxnId ?? "none"}`)

    if (!qbCustomerId) {
        logger.warn(`${LOG_PREFIX} ❌ Missing required qb_list_id for invoice creation.`)
        return
    }

    // Calculate fulfillment amount (partial fulfillment support)
    let fulfillmentAmount = order.total || 0
    let isPartial = false
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
        const orderItemsMap = new Map<string, any>((order.items || []).map((i: any) => [i.id, i]))
        const partialTotal = data.items.reduce((sum: number, fi: any) => {
            const orderItem = orderItemsMap.get(fi.item_id || fi.id)
            if (!orderItem) return sum
            return sum + (orderItem.unit_price * fi.quantity)
        }, 0)
        
        const totalOrderQty = (order.items || []).reduce((sum: number, i: any) => sum + i.quantity, 0)
        const fulfillmentQty = data.items.reduce((sum: number, fi: any) => sum + fi.quantity, 0)
        
        if (fulfillmentQty < totalOrderQty) {
            isPartial = true
        }

        if (partialTotal > 0) fulfillmentAmount = partialTotal
        logger.info(`${LOG_PREFIX} Fulfillment: $${(fulfillmentAmount / 100).toFixed(2)} of $${((order.total || 0) / 100).toFixed(2)} total (isPartial: ${isPartial})`)
    } else {
        logger.info(`${LOG_PREFIX} Full fulfillment: $${(fulfillmentAmount / 100).toFixed(2)}`)
    }

    if (!qbSoTxnId) {
        if (isPartial) {
            logger.info(`${LOG_PREFIX} ⚠️ Partial fulfillment detected but NO Sales Order exists yet! Real-Time Smart Lazy Evaluation: Forcing Sales Order creation before Invoice...`)
            // Force SO creation right now by calling handleOrderPlaced with isCron=true to bypass POS delay guard
            await handleOrderPlaced({ id: orderId }, orderModule, customerModule, _container, logger, true)
            
            // Re-fetch order metadata to get the newly created qbSoTxnId
            const refreshedOrder = await orderModule.retrieveOrder(orderId)
            qbSoTxnId = getSoTxnId(refreshedOrder.metadata || {})
            logger.info(`${LOG_PREFIX} 🔄 Post-Lazy-Eval soTxnId=${qbSoTxnId ?? "FAILED TO CREATE"}`)
        } else {
            logger.info(`${LOG_PREFIX} ℹ️ No qb_sales_order_txn_id found (100% fulfillment) — creating a STANDALONE INVOICE directly.`)
        }
    }

    // --- Standalone Invoice Prep (if no SO exists) ---
    let prebuiltItems: any[] | undefined
    let salesTaxCode: string | undefined

    if (!qbSoTxnId) {
        const qbConfig = await getQbConfig()
        const orderDiscountTotal = Math.round((order.discount_total || 0) * 100)

        const activeItems = (order.items || [])
            .filter((item: any) => (item.quantity ?? 0) > 0)
            .map((item: any) => ({
                ...item,
                unit_price: Math.round((item.unit_price || 0) * 100),
                subtotal: undefined, // Force buildQbItems to use original unit_price, ignore item-level discounts
            }))

        prebuiltItems = buildQbItems(activeItems, order.metadata)

        const shippingItem = buildShippingQbItem(
            (order as any).shipping_methods || [],
            qbConfig.shippingItemId
        )
        if (shippingItem) {
            prebuiltItems.push(shippingItem)
            logger.info(`${LOG_PREFIX} Shipping line added for standalone invoice: $${shippingItem.price?.toFixed(2)}`)
        }

        if (orderDiscountTotal > 0) {
            const orderSubtotal = Math.round((order.subtotal || 0) * 100)
            const discountPercent = orderSubtotal > 0 ? (orderDiscountTotal / orderSubtotal) * 100 : null
            buildQbOrderDiscountLines(orderDiscountTotal, discountPercent).forEach(l => prebuiltItems!.push(l))
            logger.info(`${LOG_PREFIX} Discount lines added to standalone invoice: -$${(orderDiscountTotal/100).toFixed(2)}`)
        }

        const hasTax = order.tax_total && order.tax_total > 0
        salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined
    }

    const result = await processInvoiceInQb({
        orderId,
        orderDisplayId: order.display_id,
        qbCustomerId,
        qbSoTxnId,
        qbPaymentTxnId,
        paymentAmount: fulfillmentAmount,
        prebuiltItems,
        salesTaxCode,
    })

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} ⏭️ Invoice skipped (QB disabled)`)
        return
    }
    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ processInvoiceInQb error: ${result.error}`)
        return
    }

    // Save invoice metadata (new structured JSON shape — appends to qb_invoices array)
    if (result.txnId || result.operationId) {
        try {
            const fulfillmentId: string | null = (data.fulfillment_id as string | undefined) ?? null
            const patch = buildInvoicePatch(order.metadata || {}, {
                txnId:         result.txnId || null,
                refNumber:     result.refNumber || null,
                operationId:   result.operationId || null,
                fulfillmentId,
            })
            await orderModule.updateOrders(orderId, { metadata: patch })
            logger.info(`${LOG_PREFIX} ✅ Saved invoice metadata — TxnID=${result.txnId}, Ref=${result.refNumber}, ful=${fulfillmentId}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save invoice metadata: ${metaErr.message}`)
        }
    }
}

// ─── Cancel Order Handler ────────────────────────────────────────────────────

async function handleOrderCanceled(
    data: any,
    orderModule: any,
    logger: any
) {
    const orderId = data.id || data.order_id
    logger.info(`${LOG_PREFIX} ── order.canceled → ${orderId} ──`)

    let order: any
    try {
        order = await orderModule.retrieveOrder(orderId)
        logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

    // Note: We no longer guard against isPosOrder here because POS orders
    // will now have their documents generated by the backend, so the backend
    // should also void/delete them when canceled.

    const meta = order.metadata || {}
    // Read via compat helpers — supports both old flat fields and new JSON shape
    const soTxnId = getSoTxnId(meta)
    const soRef = getSoRef(meta)
    const invoiceTxnId = getLatestInvoiceTxnId(meta)
    const invoiceRef = getLatestInvoiceRef(meta)

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to cancel`)
        return
    }

    // Build a human-readable list of what's being cancelled (e.g. "SO #6176, Invoice #5")
    const docParts: string[] = []
    if (soTxnId) docParts.push(`SO${soRef ? ` #${soRef}` : ` (${soTxnId})`}`)
    if (invoiceTxnId) docParts.push(`Invoice${invoiceRef ? ` #${invoiceRef}` : ` (${invoiceTxnId})`}`)
    const docLabel = docParts.join(', ')

    // Start Activity Log entry
    let logId: string | undefined
    try {
        process.stdout.write(`[QB-CANCEL-LOG] Attempting QbSyncLogger.start for order ${orderId}, display_id=${order.display_id}\n`)
        logId = await QbSyncLogger.start({
            operation: "cancel",
            orderId,
            orderDisplayId: order.display_id,
            eventType: "order.canceled",
            message: `Cancelling ${docLabel} for Order #${order.display_id ?? orderId}`,
        })
        process.stdout.write(`[QB-CANCEL-LOG] QbSyncLogger.start succeeded: logId=${logId}\n`)
    } catch (logErr: any) {
        process.stderr.write(`[QB-CANCEL-LOG] QbSyncLogger.start FAILED: ${logErr?.code} | ${logErr?.message} | ${logErr?.stack?.slice(0, 300)}\n`)
        logger.warn(`${LOG_PREFIX} ⚠️ Could not start sync log: ${logErr.message}`)
    }

    let invoiceOpId: string | undefined
    let soOpId: string | undefined
    let errorMsg: string | undefined

    // Void Invoice if it exists
    if (invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Voiding QB Invoice ${invoiceTxnId}...`)
        const result = await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void invoice: ${result.error}`)
            errorMsg = `Invoice void failed: ${result.error}`
        } else {
            invoiceOpId = result.data?.operationId
            logger.info(`${LOG_PREFIX} ✅ Invoice void queued (op: ${invoiceOpId})`)
        }
    }

    // Close Sales Order
    if (soTxnId) {
        logger.info(`${LOG_PREFIX} Closing QB SO ${soTxnId}...`)
        const result = await closeSalesOrderInQb(soTxnId, (msg: string) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to close SO: ${result.error}`)
            errorMsg = errorMsg ? `${errorMsg}; SO close failed: ${result.error}` : `SO close failed: ${result.error}`
        } else {
            soOpId = result.data?.operationId
            logger.info(`${LOG_PREFIX} ✅ SO close queued (op: ${soOpId})`)
        }
    }

    // Finalize Activity Log
    if (logId) {
        try {
            if (errorMsg) {
                await QbSyncLogger.fail(logId, errorMsg, {
                    message: `Failed to cancel ${docLabel} for Order #${order.display_id ?? orderId}`,
                })
            } else {
                // Use SO ref as primary; fall back to invoice ref
                const finalRef = soRef ?? invoiceRef
                await QbSyncLogger.complete(logId, {
                    qbTxnId: soTxnId ?? invoiceTxnId,
                    qbRefNumber: finalRef,
                    qbOperationId: soOpId ?? invoiceOpId,
                    message: `${docLabel} closed/voided for Order #${order.display_id ?? orderId}`,
                })
            }
        } catch (logErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not finalize sync log: ${logErr.message}`)
        }
    }
}

// ─── Customer Transfer Handler ───────────────────────────────────────────────

async function handleCustomerTransferred(
    data: any,
    orderModule: any,
    logger: any
) {
    const orderId = data.id || data.order_id
    logger.info(`${LOG_PREFIX} ── order.customer_transferred → ${orderId} ──`)

    let order: any
    try {
        order = await orderModule.retrieveOrder(orderId, { relations: ["customer"] })
        logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

    // POS guard
    if (isPosOrder(order)) {
        logger.info(`${LOG_PREFIX} ⏭️ POS order — customer transfer handled by POS, skipping`)
        return
    }

    const meta = order.metadata || {}
    const newQbCustomerId = order.customer?.metadata?.qb_list_id as string | undefined

    if (!newQbCustomerId) {
        logger.warn(`${LOG_PREFIX} New customer has no qb_list_id — cannot transfer QB documents`)
        return
    }

    // Read via compat helpers — supports both old flat fields and new JSON shape
    const soTxnId = getSoTxnId(meta)
    const soEditSeq = meta.qb_sales_order_edit_sequence as string | undefined
    const invoiceTxnId = getLatestInvoiceTxnId(meta)
    const invEditSeq = meta.qb_invoice_edit_sequence as string | undefined

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to transfer`)
        return
    }

    // Start Activity Log entry
    let logId: string | undefined
    try {
        logId = await QbSyncLogger.start({
            operation: "customer_transfer",
            orderId,
            orderDisplayId: order.display_id,
            eventType: "order.customer_transferred",
            message: `Transferring QB docs for Order #${order.display_id ?? orderId} → customer ${newQbCustomerId}`,
        })
    } catch (logErr: any) {
        logger.warn(`${LOG_PREFIX} ⚠️ Could not start sync log: ${logErr.message}`)
    }

    let errorMsg: string | undefined

    if (soTxnId && soEditSeq) {
        logger.info(`${LOG_PREFIX} Transferring SO ${soTxnId} to customer ${newQbCustomerId}`)
        const result = await transferDocumentCustomer("sales-order", soTxnId, soEditSeq, newQbCustomerId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to transfer SO customer: ${result.error}`)
            errorMsg = `SO transfer failed: ${result.error}`
        }
    }

    if (invoiceTxnId && invEditSeq) {
        logger.info(`${LOG_PREFIX} Transferring Invoice ${invoiceTxnId} to customer ${newQbCustomerId}`)
        const result = await transferDocumentCustomer("invoice", invoiceTxnId, invEditSeq, newQbCustomerId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to transfer invoice customer: ${result.error}`)
            errorMsg = errorMsg ? `${errorMsg}; Invoice transfer failed: ${result.error}` : `Invoice transfer failed: ${result.error}`
        }
    }

    // Finalize Activity Log
    if (logId) {
        try {
            if (errorMsg) {
                await QbSyncLogger.fail(logId, errorMsg)
            } else {
                await QbSyncLogger.complete(logId, {
                    qbTxnId: soTxnId,
                    message: `QB docs transferred to customer ${newQbCustomerId} for Order #${order.display_id ?? orderId}`,
                })
            }
        } catch (logErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not finalize sync log: ${logErr.message}`)
        }
    }
}

// ─── Subscriber Configuration ────────────────────────────────────────────────

export default qbOrderSubscriber

export const config: SubscriberConfig = {
    event: [
        "order.placed",
        "order.payment_captured",
        "order.fulfillment_created",
        "order.canceled",
        "order.customer_transferred",
    ],
    context: {
        subscriberId: "qb-order-subscriber",
    },
}
