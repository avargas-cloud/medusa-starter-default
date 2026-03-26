import { processPaymentCaptureInQb } from "../order-flow-core"
import { buildPaymentPatch, getLatestInvoiceTxnId } from "../qb-metadata-types"
import { applyPaymentToInvoiceInQb } from "../qb-bridge-client"
import { LOG_PREFIX, isPosOrder } from "./utils"

export async function handlePaymentCaptured(
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

    if (isPosOrder(order)) {
        logger.info(`${LOG_PREFIX} ⏭️ Skipping order.payment_captured for POS order ${orderId}. Payment is handled by pos.payment.created event.`)
        return
    }

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

    const amountInCents = data.amount ?? order.total ?? 0
    const amount = amountInCents / 100
    logger.info(`${LOG_PREFIX} Payment amount: $${amount.toFixed(2)}`)

    const paymentMethod = "Credit Card"

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

    if (result.txnId || result.operationId) {
        const latestInvoiceTxnId = getLatestInvoiceTxnId(order.metadata)
        
        if (result.txnId && latestInvoiceTxnId) {
            logger.info(`${LOG_PREFIX} Auto-applying new payment ${result.txnId} to latest Invoice ${latestInvoiceTxnId}...`)
            const applyResult = await applyPaymentToInvoiceInQb({
                customerId: qbCustomerId,
                amount: amount,
                invoiceId: latestInvoiceTxnId,
                creditTxnId: result.txnId,
            })
            if (!applyResult.success) {
                logger.warn(`${LOG_PREFIX} ⚠️ Failed to apply payment to invoice: ${applyResult.error}`)
            } else {
                logger.info(`${LOG_PREFIX} ✅ Payment successfully applied to Invoice.`)
            }
        }

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
