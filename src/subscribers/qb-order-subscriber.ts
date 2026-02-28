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

// ─── Subscriber Handler ─────────────────────────────────────────────────────

async function qbOrderSubscriber({ event, container }: SubscriberArgs<any>) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const orderModule = container.resolve(Modules.ORDER)
    const customerModule = container.resolve(Modules.CUSTOMER)

    try {
        switch (event.name) {
            case "order.placed":
                await handleOrderPlaced(event.data, orderModule, customerModule, logger)
                break
            case "order.payment_captured":
                await handlePaymentCaptured(event.data, orderModule, logger)
                break
            case "order.fulfillment_created":
                await handleFulfillmentCreated(event.data, orderModule, logger)
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
        logger.error(`${LOG_PREFIX} ❌ Error handling ${event.name}: ${err.message}`)
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
    logger.info(`${LOG_PREFIX} order.placed → ${orderId}`)

    // In Medusa v2, orderModule cannot join cross-module relations (customer, items.variant)
    // because they live in separate modules. Fetch only order-native data first.
    const order = await orderModule.retrieveOrder(orderId, {
        relations: ["items"],
    })

    // Separately fetch the customer with their addresses (via customer module)
    let customer = null
    if (order.customer_id) {
        try {
            customer = await customerModule.retrieveCustomer(order.customer_id, {
                relations: ["addresses"],
            })
        } catch (custErr: any) {
            logger.warn(`${LOG_PREFIX} Could not fetch customer ${order.customer_id}: ${custErr.message}`)
        }
    }

    // Attach customer to order object so processOrderInQb can use it
    const orderWithCustomer = { ...order, customer }

    const result = await processOrderInQb(orderWithCustomer, customerModule)

    if (result.skipped) {
        logger.info(`${LOG_PREFIX} Skipped: ${result.skipReason}`)
        return
    }

    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ ${result.error}`)
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
                    qb_synced_at: new Date().toISOString(),
                },
            })
            logger.info(`${LOG_PREFIX} ✅ Saved SO metadata to order ${orderId}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save order metadata: ${metaErr.message}`)
        }
    }
}

async function handlePaymentCaptured(
    data: any,
    orderModule: any,
    logger: any
) {
    const orderId = data.id || data.order_id
    logger.info(`${LOG_PREFIX} order.payment_captured → ${orderId}`)

    const order = await orderModule.retrieveOrder(orderId)

    const qbCustomerId = order.metadata?.qb_list_id || order.customer?.metadata?.qb_list_id
    if (!qbCustomerId) {
        logger.warn(`${LOG_PREFIX} No qb_list_id found for order ${orderId} — skipping payment`)
        return
    }

    // Map payment method from Medusa → QB payment method name
    const paymentMethod = "Visa" // Authorize.net = Visa in QB

    const result = await processPaymentCaptureInQb({
        orderId,
        orderDisplayId: order.display_id,
        amount: data.amount || order.total || 0,
        paymentMethod,
        qbCustomerId,
    })

    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ Payment: ${result.error}`)
        return
    }

    // Save payment metadata
    if (result.txnId || result.operationId) {
        try {
            await orderModule.updateOrders(orderId, {
                metadata: {
                    ...(order.metadata || {}),
                    qb_payment_txn_id: result.txnId || null,
                    qb_payment_ref: result.refNumber || null,
                    qb_payment_operation_id: result.operationId || null,
                },
            })
            logger.info(`${LOG_PREFIX} ✅ Saved payment metadata to order ${orderId}`)
        } catch (metaErr: any) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to save payment metadata: ${metaErr.message}`)
        }
    }
}

async function handleFulfillmentCreated(
    data: any,
    orderModule: any,
    logger: any
) {
    const orderId = data.order_id || data.id
    logger.info(`${LOG_PREFIX} order.fulfillment_created → ${orderId}`)

    const order = await orderModule.retrieveOrder(orderId)

    const qbCustomerId = order.metadata?.qb_list_id || order.customer?.metadata?.qb_list_id
    const qbSoTxnId = order.metadata?.qb_sales_order_txn_id
    const qbPaymentTxnId = order.metadata?.qb_payment_txn_id

    if (!qbCustomerId || !qbSoTxnId) {
        logger.warn(`${LOG_PREFIX} Missing QB data for invoice (customerId: ${qbCustomerId}, soTxnId: ${qbSoTxnId}) — skipping`)
        return
    }

    // Calculate the amount for THIS fulfillment only (partial fulfillment support).
    // event data includes fulfillment_id and items[] — sum the fulfilled item values.
    // If not available, fall back to order.total (full payment apply).
    let fulfillmentAmount = order.total || 0
    if (data.items && Array.isArray(data.items) && data.items.length > 0) {
        // data.items are the fulfillment items: { item_id, quantity }
        const orderItemsMap = new Map<string, any>((order.items || []).map((i: any) => [i.id, i]))
        const partialTotal = data.items.reduce((sum: number, fi: any) => {
            const orderItem = orderItemsMap.get(fi.item_id || fi.id)
            if (!orderItem) return sum
            return sum + (orderItem.unit_price * fi.quantity)
        }, 0)
        if (partialTotal > 0) fulfillmentAmount = partialTotal
        logger.info(`${LOG_PREFIX} Partial fulfillment amount: $${(fulfillmentAmount / 100).toFixed(2)} of $${((order.total || 0) / 100).toFixed(2)} total`)
    }

    const result = await processInvoiceInQb({
        orderId,
        orderDisplayId: order.display_id,
        qbCustomerId,
        qbSoTxnId,
        qbPaymentTxnId,
        paymentAmount: fulfillmentAmount,
    })

    if (result.error) {
        logger.error(`${LOG_PREFIX} ❌ Invoice: ${result.error}`)
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
            logger.info(`${LOG_PREFIX} ✅ Saved invoice metadata to order ${orderId}`)
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
    logger.info(`${LOG_PREFIX} order.canceled → ${orderId}`)

    const order = await orderModule.retrieveOrder(orderId)
    const meta = order.metadata || {}

    const soTxnId = meta.qb_sales_order_txn_id as string | undefined
    const soEditSeq = meta.qb_sales_order_edit_sequence as string | undefined
    const invoiceTxnId = meta.qb_invoice_txn_id as string | undefined

    // Void Invoice if it exists (takes priority — SO is implicitly closed when invoice is issued)
    if (invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Voiding QB Invoice ${invoiceTxnId} for order ${orderId}`)
        const result = await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void invoice: ${result.error}`)
        } else {
            logger.info(`${LOG_PREFIX} ✅ Invoice void queued (op: ${result.data?.operationId})`)
        }
    }

    // Close Sales Order (requires EditSequence — skip if not stored)
    if (soTxnId && soEditSeq) {
        logger.info(`${LOG_PREFIX} Closing QB SO ${soTxnId} for order ${orderId}`)
        const result = await closeSalesOrderInQb(soTxnId, soEditSeq, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to close SO: ${result.error}`)
        } else {
            logger.info(`${LOG_PREFIX} ✅ SO close queued (op: ${result.data?.operationId})`)
        }
    } else if (soTxnId && !soEditSeq) {
        logger.warn(`${LOG_PREFIX} SO ${soTxnId} found but no EditSequence stored — cannot close SO automatically. Close manually in QB.`)
    }

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to cancel`)
    }
}

// ─── Customer Transfer Handler ───────────────────────────────────────────────

async function handleCustomerTransferred(
    data: any,
    orderModule: any,
    logger: any
) {
    const orderId = data.id || data.order_id
    logger.info(`${LOG_PREFIX} order.customer_transferred → ${orderId}`)

    const order = await orderModule.retrieveOrder(orderId, { relations: ["customer"] })
    const meta = order.metadata || {}

    // Get new customer's QB ListID
    const newQbCustomerId = order.customer?.metadata?.qb_list_id as string | undefined
    if (!newQbCustomerId) {
        logger.warn(`${LOG_PREFIX} New customer has no qb_list_id — cannot transfer QB documents`)
        return
    }

    const soTxnId = meta.qb_sales_order_txn_id as string | undefined
    const soEditSeq = meta.qb_sales_order_edit_sequence as string | undefined
    const invoiceTxnId = meta.qb_invoice_txn_id as string | undefined
    const invEditSeq = meta.qb_invoice_edit_sequence as string | undefined

    // Transfer SO customer
    if (soTxnId && soEditSeq) {
        logger.info(`${LOG_PREFIX} Transferring SO ${soTxnId} to customer ${newQbCustomerId}`)
        const result = await transferDocumentCustomer("sales-order", soTxnId, soEditSeq, newQbCustomerId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to transfer SO customer: ${result.error}`)
        }
    }

    // Transfer Invoice customer
    if (invoiceTxnId && invEditSeq) {
        logger.info(`${LOG_PREFIX} Transferring Invoice ${invoiceTxnId} to customer ${newQbCustomerId}`)
        const result = await transferDocumentCustomer("invoice", invoiceTxnId, invEditSeq, newQbCustomerId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to transfer invoice customer: ${result.error}`)
        }
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
