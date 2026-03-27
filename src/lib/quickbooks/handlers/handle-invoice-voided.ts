import { voidInvoiceInQb, voidSalesReceiptInQb } from "../qb-bridge-client"
import { QbSyncLogger } from "../qb-sync-logger"
import { LOG_PREFIX } from "./utils"
import { getDbPool } from "../../../api/utils/db-pool"

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

    let isSalesReceipt = false
    try {
        const pool = getDbPool()
        const res = await pool.query(`SELECT metadata FROM pos_invoice WHERE id = $1`, [invoice_id])
        if (res.rows[0]?.metadata?.is_sales_receipt) {
            isSalesReceipt = true
        }
    } catch (e: any) {
        isSalesReceipt = invoiceRef?.startsWith('SR-') || false
    }
    
    const documentTypeName = isSalesReceipt ? "Sales Receipt" : "Invoice"

    let logId: string | undefined
    try {
        logId = await QbSyncLogger.start({
            operation: isSalesReceipt ? "void_sales_receipt" as any : "void_invoice",
            orderId: order_id,
            orderDisplayId: order.display_id,
            eventType: "pos.invoice.voided",
            message: `Voiding QB ${documentTypeName} ${invoiceRef ?? invoiceTxnId} for Order #${order.display_id}`,
        })
    } catch (logErr: any) {
        logger.warn(`${LOG_PREFIX} ⚠️ Could not start sync log: ${logErr.message}`)
    }

    logger.info(`${LOG_PREFIX} Voiding QB ${documentTypeName} ${invoiceTxnId}...`)
    
    // Inject pre-flight metadata so UI shows "VOIDING..."
    try {
        await orderModule.updateOrders(order_id, {
            metadata: { ...(order.metadata || {}), qb_sync_status: "voiding" }
        })
    } catch (mErr) {
        logger.warn(`${LOG_PREFIX} Could not set voiding status: ${mErr}`)
    }

    // Dynamically choose correct Bridge method
    const result = isSalesReceipt 
        ? await voidSalesReceiptInQb(invoiceTxnId, (msg) => logger.info(msg))
        : await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))
    
    if (logId) {
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void ${documentTypeName.toLowerCase()}: ${result.error}`)
            await QbSyncLogger.fail(logId, `${documentTypeName} void failed: ${result.error}`)
            try {
                await orderModule.updateOrders(order_id, {
                    metadata: { ...(order.metadata || {}), qb_sync_status: "error" }
                })
            } catch (mErr) {}
        } else {
            logger.info(`${LOG_PREFIX} ✅ ${documentTypeName} void queued (op: ${result.data?.operationId})`)
            await QbSyncLogger.complete(logId, {
                qbTxnId: invoiceTxnId,
                qbRefNumber: invoiceRef,
                qbOperationId: result.data?.operationId,
                message: `${documentTypeName} ${invoiceRef ?? invoiceTxnId} voided in QB`,
            })
            // Wait, note that a void operation in the queue might need polling, but voiding usually returns true quickly or queues it.
            // Let's optimisticly set voided or rely on the webhook. The manual sync only cares if it's explicitly 'error' to retry.
            try {
                await orderModule.updateOrders(order_id, {
                    metadata: { ...(order.metadata || {}), qb_sync_status: "voided" }
                })
            } catch (mErr) {}
        }
    } else {
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void ${documentTypeName.toLowerCase()}: ${result.error}`)
            try {
                await orderModule.updateOrders(order_id, {
                    metadata: { ...(order.metadata || {}), qb_sync_status: "error" }
                })
            } catch (mErr) {}
        } else {
            logger.info(`${LOG_PREFIX} ✅ ${documentTypeName} void queued (op: ${result.data?.operationId})`)
            try {
                await orderModule.updateOrders(order_id, {
                    metadata: { ...(order.metadata || {}), qb_sync_status: "voided" }
                })
            } catch (mErr) {}
        }
    }
}
