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
 * Metadata stored on order:
 *   qb_sales_order_txn_id, qb_sales_order_ref
 *   qb_payment_txn_id, qb_payment_ref
 *   qb_invoice_txn_id, qb_invoice_ref
 */

import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
    processOrderInQb,
    processPaymentCaptureInQb,
    processInvoiceInQb,
} from "../lib/quickbooks/order-flow-core"
import {
    closeSalesOrderInQb,
    voidInvoiceInQb,
    transferDocumentCustomer,
} from "../lib/quickbooks/qb-bridge-client"

const LOG_PREFIX = "[QB-ORDER]"
const ENABLED = process.env.QB_ORDER_FLOW_ENABLED === "true"

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
                await handleOrderPlaced(event.data, orderModule, customerModule, logger)
                break
            case "order.payment_captured":
                await handlePaymentCaptured(event.data, orderModule, customerModule, logger)
                break
            case "order.fulfillment_created":
                await handleFulfillmentCreated(event.data, orderModule, customerModule, logger)
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

async function handleOrderPlaced(
    data: any,
    orderModule: any,
    customerModule: any,
    logger: any
) {
    const orderId = data.id
    logger.info(`${LOG_PREFIX} ── order.placed → ${orderId} ──`)

    // Fetch order (Medusa v2: cross-module relations need separate fetches)
    let order: any
    try {
        order = await orderModule.retrieveOrder(orderId, { relations: ["items"] })
        logger.info(`${LOG_PREFIX} Order fetched: #${order.display_id}, customer_id=${order.customer_id}, items=${order.items?.length ?? 0}`)
        logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

    // Check for draft→order path (estimate metadata on order)
    const estimateTxnId = order.metadata?.qb_estimate_txn_id
    if (estimateTxnId) {
        logger.info(`${LOG_PREFIX} ✅ Order has qb_estimate_txn_id=${estimateTxnId} — will convert Estimate→SO (skip customer re-check)`)
    } else {
        logger.info(`${LOG_PREFIX} ℹ️ No qb_estimate_txn_id — direct order path (will check customer)`)
    }

    // Fetch customer separately
    let customer = null
    if (order.customer_id) {
        try {
            customer = await customerModule.retrieveCustomer(order.customer_id, {
                relations: ["addresses"],
            })
            logger.info(`${LOG_PREFIX} Customer fetched: ${customer.email} | qb_list_id=${customer.metadata?.qb_list_id ?? "NOT SET"}`)
        } catch (custErr: any) {
            logger.warn(`${LOG_PREFIX} ⚠️ Could not fetch customer ${order.customer_id}: ${custErr.message}`)
        }
    } else {
        logger.warn(`${LOG_PREFIX} ⚠️ Order ${orderId} has no customer_id`)
    }

    const orderWithCustomer = { ...order, customer }

    const result = await processOrderInQb(orderWithCustomer, customerModule)

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

    // Save QB metadata to order
    if (result.soTxnId || result.operationId) {
        try {
            await orderModule.updateOrders(orderId, {
                metadata: {
                    ...(order.metadata || {}),
                    qb_sales_order_txn_id: result.soTxnId || null,
                    qb_sales_order_ref: result.soRefNumber || null,
                    qb_sales_order_operation_id: result.operationId || null,
                    qb_list_id: result.customerId || null,  // ← Also store on order for quick access
                    qb_synced_at: new Date().toISOString(),
                },
            })
            logger.info(`${LOG_PREFIX} ✅ Saved SO metadata — TxnID=${result.soTxnId}, Ref=${result.soRefNumber}, OpID=${result.operationId}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save order metadata: ${metaErr.message}`)
        }
    } else {
        logger.warn(`${LOG_PREFIX} ⚠️ No soTxnId or operationId returned — QB document may not have been created`)
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

    // Save payment metadata
    if (result.txnId || result.operationId) {
        try {
            await orderModule.updateOrders(orderId, {
                metadata: {
                    ...(order.metadata || {}),
                    qb_list_id: qbCustomerId,   // ensure it's persisted
                    qb_payment_txn_id: result.txnId || null,
                    qb_payment_ref: result.refNumber || null,
                    qb_payment_operation_id: result.operationId || null,
                },
            })
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
    logger: any
) {
    const orderId = data.order_id || data.id
    logger.info(`${LOG_PREFIX} ── order.fulfillment_created → orderId=${orderId} ──`)
    logger.info(`${LOG_PREFIX} Fulfillment event data: ${JSON.stringify(data)}`)

    let order: any
    try {
        order = await orderModule.retrieveOrder(orderId, { relations: ["items"] })
        logger.info(`${LOG_PREFIX} Order fetched: #${order.display_id}, customer_id=${order.customer_id}`)
        logger.info(`${LOG_PREFIX} Order metadata: ${JSON.stringify(order.metadata || {})}`)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${orderId}: ${err.message}`)
        return
    }

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

    const qbSoTxnId: string | undefined = order.metadata?.qb_sales_order_txn_id
    const qbPaymentTxnId: string | undefined = order.metadata?.qb_payment_txn_id

    logger.info(`${LOG_PREFIX} QB data — customerId=${qbCustomerId ?? "MISSING"}, soTxnId=${qbSoTxnId ?? "MISSING"}, paymentTxnId=${qbPaymentTxnId ?? "none"}`)

    if (!qbCustomerId || !qbSoTxnId) {
        logger.warn(`${LOG_PREFIX} ❌ Missing required QB data for invoice creation:`)
        if (!qbCustomerId) logger.warn(`${LOG_PREFIX}   → qb_list_id is missing (check that order.placed succeeded)`)
        if (!qbSoTxnId) logger.warn(`${LOG_PREFIX}   → qb_sales_order_txn_id is missing (SO must exist before invoice)`)
        return
    }

    // Calculate fulfillment amount (partial fulfillment support)
    let fulfillmentAmount = order.total || 0
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
        const orderItemsMap = new Map<string, any>((order.items || []).map((i: any) => [i.id, i]))
        const partialTotal = data.items.reduce((sum: number, fi: any) => {
            const orderItem = orderItemsMap.get(fi.item_id || fi.id)
            if (!orderItem) return sum
            return sum + (orderItem.unit_price * fi.quantity)
        }, 0)
        if (partialTotal > 0) fulfillmentAmount = partialTotal
        logger.info(`${LOG_PREFIX} Partial fulfillment: $${(fulfillmentAmount / 100).toFixed(2)} of $${((order.total || 0) / 100).toFixed(2)} total`)
    } else {
        logger.info(`${LOG_PREFIX} Full fulfillment: $${(fulfillmentAmount / 100).toFixed(2)}`)
    }

    const result = await processInvoiceInQb({
        orderId,
        orderDisplayId: order.display_id,
        qbCustomerId,
        qbSoTxnId,
        qbPaymentTxnId,
        paymentAmount: fulfillmentAmount,
    })

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} ⏭️ Invoice skipped (QB disabled)`)
        return
    }
    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ processInvoiceInQb error: ${result.error}`)
        return
    }

    // Save invoice metadata
    if (result.txnId || result.operationId) {
        try {
            await orderModule.updateOrders(orderId, {
                metadata: {
                    ...(order.metadata || {}),
                    qb_invoice_txn_id: result.txnId || null,
                    qb_invoice_ref: result.refNumber || null,
                    qb_invoice_operation_id: result.operationId || null,
                },
            })
            logger.info(`${LOG_PREFIX} ✅ Saved invoice metadata — TxnID=${result.txnId}, Ref=${result.refNumber}`)
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

    const meta = order.metadata || {}
    const soTxnId = meta.qb_sales_order_txn_id as string | undefined
    const soEditSeq = meta.qb_sales_order_edit_sequence as string | undefined
    const invoiceTxnId = meta.qb_invoice_txn_id as string | undefined

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to cancel`)
        return
    }

    // Void Invoice if it exists
    if (invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Voiding QB Invoice ${invoiceTxnId}...`)
        const result = await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void invoice: ${result.error}`)
        } else {
            logger.info(`${LOG_PREFIX} ✅ Invoice void queued (op: ${result.data?.operationId})`)
        }
    }

    // Close Sales Order
    if (soTxnId && soEditSeq) {
        logger.info(`${LOG_PREFIX} Closing QB SO ${soTxnId}...`)
        const result = await closeSalesOrderInQb(soTxnId, soEditSeq, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to close SO: ${result.error}`)
        } else {
            logger.info(`${LOG_PREFIX} ✅ SO close queued (op: ${result.data?.operationId})`)
        }
    } else if (soTxnId && !soEditSeq) {
        logger.warn(`${LOG_PREFIX} SO ${soTxnId} found but no EditSequence stored — close manually in QB`)
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

    const meta = order.metadata || {}
    const newQbCustomerId = order.customer?.metadata?.qb_list_id as string | undefined

    if (!newQbCustomerId) {
        logger.warn(`${LOG_PREFIX} New customer has no qb_list_id — cannot transfer QB documents`)
        return
    }

    const soTxnId = meta.qb_sales_order_txn_id as string | undefined
    const soEditSeq = meta.qb_sales_order_edit_sequence as string | undefined
    const invoiceTxnId = meta.qb_invoice_txn_id as string | undefined
    const invEditSeq = meta.qb_invoice_edit_sequence as string | undefined

    if (soTxnId && soEditSeq) {
        logger.info(`${LOG_PREFIX} Transferring SO ${soTxnId} to customer ${newQbCustomerId}`)
        const result = await transferDocumentCustomer("sales-order", soTxnId, soEditSeq, newQbCustomerId, (msg) => logger.info(msg))
        if (!result.success) logger.error(`${LOG_PREFIX} ⚠️ Failed to transfer SO customer: ${result.error}`)
    }

    if (invoiceTxnId && invEditSeq) {
        logger.info(`${LOG_PREFIX} Transferring Invoice ${invoiceTxnId} to customer ${newQbCustomerId}`)
        const result = await transferDocumentCustomer("invoice", invoiceTxnId, invEditSeq, newQbCustomerId, (msg) => logger.info(msg))
        if (!result.success) logger.error(`${LOG_PREFIX} ⚠️ Failed to transfer invoice customer: ${result.error}`)
    }

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to transfer`)
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
