import { closeSalesOrderInQb, voidInvoiceInQb } from "../qb-bridge-client"
import { QbSyncLogger } from "../qb-sync-logger"
import { writePipelineRow } from "../qb-pipeline"
import { getSoTxnId, getSoRef, getLatestInvoiceTxnId, getLatestInvoiceRef } from "../qb-metadata-types"
import { LOG_PREFIX } from "./utils"

export async function handleOrderCanceled(
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
    const soTxnId = getSoTxnId(meta)
    const soRef = getSoRef(meta)
    const invoiceTxnId = getLatestInvoiceTxnId(meta)
    const invoiceRef = getLatestInvoiceRef(meta)

    if (!soTxnId && !invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Order ${orderId} has no QB documents — nothing to cancel`)
        return
    }

    const docParts: string[] = []
    if (soTxnId) docParts.push(`SO${soRef ? ` #${soRef}` : ` (${soTxnId})`}`)
    if (invoiceTxnId) docParts.push(`Invoice${invoiceRef ? ` #${invoiceRef}` : ` (${invoiceTxnId})`}`)
    const docLabel = docParts.join(', ')

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

    if (invoiceTxnId) {
        logger.info(`${LOG_PREFIX} Voiding QB Invoice ${invoiceTxnId}...`)
        const result = await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to void invoice: ${result.error}`)
            errorMsg = `Invoice void failed: ${result.error}`
            try {
                await writePipelineRow({
                    orderId:         orderId,
                    step:            "void_invoice",
                    status:          "failed",
                    qbTxnId:         invoiceTxnId,
                    qbRefNumber:     invoiceRef ?? null,
                    medusaRefNumber: invoiceRef ?? null,
                    error:           result.error ?? "Invoice void failed",
                })
            } catch (pErr: any) { logger.warn(`${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`) }
        } else {
            invoiceOpId = result.data?.operationId
            logger.info(`${LOG_PREFIX} ✅ Invoice void queued (op: ${invoiceOpId})`)
            try {
                await writePipelineRow({
                    orderId:         orderId,
                    step:            "void_invoice",
                    status:          "submitted",
                    bridgeOpId:      invoiceOpId ?? null,
                    qbTxnId:         invoiceTxnId,
                    qbRefNumber:     invoiceRef ?? null,
                    medusaRefNumber: invoiceRef ?? null,
                })
            } catch (pErr: any) { logger.warn(`${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`) }
        }
    }

    if (soTxnId) {
        logger.info(`${LOG_PREFIX} Closing QB SO ${soTxnId}...`)
        const result = await closeSalesOrderInQb(soTxnId, (msg: string) => logger.info(msg))
        if (!result.success) {
            logger.error(`${LOG_PREFIX} ⚠️ Failed to close SO: ${result.error}`)
            errorMsg = errorMsg ? `${errorMsg}; SO close failed: ${result.error}` : `SO close failed: ${result.error}`
            try {
                await writePipelineRow({
                    orderId:         orderId,
                    step:            "void_sales_order",
                    status:          "failed",
                    qbTxnId:         soTxnId,
                    qbRefNumber:     soRef ?? null,
                    medusaRefNumber: soRef ?? null,
                    error:           result.error ?? "SO close failed",
                })
            } catch (pErr: any) { logger.warn(`${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`) }
        } else {
            soOpId = result.data?.operationId
            logger.info(`${LOG_PREFIX} ✅ SO close queued (op: ${soOpId})`)
            try {
                await writePipelineRow({
                    orderId:         orderId,
                    step:            "void_sales_order",
                    status:          "submitted",
                    bridgeOpId:      soOpId ?? null,
                    qbTxnId:         soTxnId,
                    qbRefNumber:     soRef ?? null,
                    medusaRefNumber: soRef ?? null,
                })
            } catch (pErr: any) { logger.warn(`${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`) }
        }
    }

    if (logId) {
        try {
            if (errorMsg) {
                await QbSyncLogger.fail(logId, errorMsg, {
                    message: `Failed to cancel ${docLabel} for Order #${order.display_id ?? orderId}`,
                })
            } else {
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
