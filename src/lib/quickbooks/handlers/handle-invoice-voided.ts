import { voidInvoiceInQb } from "../qb-bridge-client"
import { QbSyncLogger } from "../qb-sync-logger"
import { LOG_PREFIX } from "./utils"

export async function handleInvoiceVoided(data: any, orderModule: any, logger: any) {
    const { order_id, invoice_id, fulfillment_id } = data
    logger.info(`${LOG_PREFIX} ── pos.invoice.voided → Order ${order_id} | POS Invoice ${invoice_id} ──`)

    let order: any
    try {
        order = await orderModule.retrieveOrder(order_id)
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} ❌ Failed to fetch order ${order_id}: ${err.message}`)
        return
    }

    const qbInvoices = order.metadata?.qb_invoices as any[] || []
    
    let targetInv = null
    if (fulfillment_id) {
        targetInv = qbInvoices.find(inv => inv.fulfillment_id === fulfillment_id)
    }
    
    if (!targetInv && qbInvoices.length > 0) {
        targetInv = qbInvoices[qbInvoices.length - 1]
    }

    if (!targetInv?.txn_id) {
        logger.info(`${LOG_PREFIX} Order ${order_id} has no matching QB invoice to void.`)
        return
    }

    const { txn_id: invoiceTxnId, ref_number: invoiceRef } = targetInv

    let logId: string | undefined
    try {
        logId = await QbSyncLogger.start({
            operation: "void_invoice",
            orderId: order_id,
            orderDisplayId: order.display_id,
            eventType: "pos.invoice.voided",
            message: `Voiding QB Invoice ${invoiceRef ?? invoiceTxnId} for Order #${order.display_id}`,
        })
    } catch (logErr: any) {
        logger.warn(`${LOG_PREFIX} ⚠️ Could not start sync log: ${logErr.message}`)
    }

    logger.info(`${LOG_PREFIX} Voiding QB Invoice ${invoiceTxnId}...`)
    const result = await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))
    
    if (logId) {
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void invoice: ${result.error}`)
            await QbSyncLogger.fail(logId, `Invoice void failed: ${result.error}`)
        } else {
            logger.info(`${LOG_PREFIX} ✅ Invoice void queued (op: ${result.data?.operationId})`)
            await QbSyncLogger.complete(logId, {
                qbTxnId: invoiceTxnId,
                qbRefNumber: invoiceRef,
                qbOperationId: result.data?.operationId,
                message: `Invoice ${invoiceRef ?? invoiceTxnId} voided in QB`,
            })
        }
    } else {
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void invoice: ${result.error}`)
        } else {
            logger.info(`${LOG_PREFIX} ✅ Invoice void queued (op: ${result.data?.operationId})`)
        }
    }
}
