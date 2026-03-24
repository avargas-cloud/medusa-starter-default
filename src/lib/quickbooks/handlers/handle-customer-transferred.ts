import { transferDocumentCustomer } from "../qb-bridge-client"
import { QbSyncLogger } from "../qb-sync-logger"
import { getSoTxnId, getLatestInvoiceTxnId } from "../qb-metadata-types"
import { LOG_PREFIX, isPosOrder } from "./utils"

export async function handleCustomerTransferred(
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

    const soTxnId = getSoTxnId(meta)
    const soEditSeq = meta.qb_sales_order_edit_sequence as string | undefined
    const invoiceTxnId = getLatestInvoiceTxnId(meta)
    const invEditSeq = meta.qb_invoice_edit_sequence as string | undefined

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to transfer`)
        return
    }

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
