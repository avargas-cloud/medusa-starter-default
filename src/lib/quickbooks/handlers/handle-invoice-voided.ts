import { voidInvoiceInQb, voidSalesReceiptInQb } from "../qb-bridge-client"
import { QbSyncLogger } from "../qb-sync-logger"
import { writePipelineRow } from "../qb-pipeline"
import { LOG_PREFIX } from "./utils"
import { getDbPool } from "../../../api/utils/db-pool"
import { FINANCE_MODULE } from "../../../modules/finance"

export async function handleInvoiceVoided(data: any, orderModule: any, logger: any, _container?: any) {
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
            operation: isSalesReceipt ? "void_sales_receipt" : "void_invoice",
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

    const pipelineStep = isSalesReceipt ? "void_sales_receipt" : "void_invoice"

    try {
        await writePipelineRow({
            orderId: order_id,
            referenceId: invoice_id ?? null,
            referenceType: "pos_invoice",
            step: pipelineStep,
            status: "pending",
            qbTxnId: invoiceTxnId,
            qbRefNumber: invoiceRef ?? null,
            medusaRefNumber: invoice_id ?? null
        })
    } catch (pErr: any) {
        logger.warn(`${LOG_PREFIX} Could not write pre-flight pipeline row: ${pErr.message}`)
    }

    // Dynamically choose correct Bridge method
    const result = isSalesReceipt 
        ? await voidSalesReceiptInQb(invoiceTxnId, (msg) => logger.info(msg))
        : await voidInvoiceInQb(invoiceTxnId, (msg) => logger.info(msg))

    if (!result.success) {
        logger.error(`${LOG_PREFIX} ⚠️ Failed to void ${documentTypeName.toLowerCase()}: ${result.error}`)
        if (logId) await QbSyncLogger.fail(logId, `${documentTypeName} void failed: ${result.error}`)
        try {
            await writePipelineRow({
                orderId:         order_id,
                referenceId:     invoice_id ?? null,
                referenceType:   "pos_invoice",
                step:            pipelineStep,
                status:          "failed",
                qbTxnId:         invoiceTxnId,
                qbRefNumber:     invoiceRef ?? null,
                medusaRefNumber: invoice_id ?? null,
                error:           result.error ?? `${documentTypeName} void failed`,
            })
        } catch (pErr: any) { logger.warn(`${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`) }
        try {
            await orderModule.updateOrders(order_id, {
                metadata: { ...(order.metadata || {}), qb_sync_status: "error" }
            })
        } catch (mErr) {}
    } else {
        logger.info(`${LOG_PREFIX} ✅ ${documentTypeName} void queued (op: ${result.data?.operationId})`)
        if (logId) await QbSyncLogger.complete(logId, {
            qbTxnId: invoiceTxnId,
            qbRefNumber: invoiceRef,
            qbOperationId: result.data?.operationId,
            message: `${documentTypeName} ${invoiceRef ?? invoiceTxnId} voided in QB`,
        })
        try {
            await writePipelineRow({
                orderId:         order_id,
                referenceId:     invoice_id ?? null,
                referenceType:   "pos_invoice",
                step:            pipelineStep,
                status:          "submitted",
                bridgeOpId:      result.data?.operationId ?? null,
                qbTxnId:         invoiceTxnId,
                qbRefNumber:     invoiceRef ?? null,
                medusaRefNumber: invoice_id ?? null,
            })
        } catch (pErr: any) { logger.warn(`${LOG_PREFIX} Could not write pipeline row: ${pErr.message}`) }
        try {
            await orderModule.updateOrders(order_id, {
                metadata: { ...(order.metadata || {}), qb_sync_status: "voided" }
            })
        } catch (mErr) {}

        if (isSalesReceipt) {
            await voidSRPaymentIfExists({ invoice_id, logger, _container })
        }
    }
}

/**
 * Finds the customer_payment linked to a Sales Receipt invoice (via qb_source='sales_receipt')
 * and marks it voided. Safe to call even if no SR payment exists.
 */
async function voidSRPaymentIfExists({ invoice_id, logger, _container }: {
    invoice_id: string | undefined
    logger: any
    _container: any
}) {
    if (!invoice_id || !_container) return
    try {
        const financeService = _container.resolve(FINANCE_MODULE) as any
        const pool = getDbPool()

        // Find the payment linked to this invoice via payment applications
        const res = await pool.query(
            `SELECT cp.id, cp.status, cp.metadata, cp.qb
             FROM customer_payment cp
             JOIN payment_application pa ON pa.payment_id = cp.id
             WHERE pa.invoice_id = $1
               AND (cp.metadata->>'qb_source' = 'sales_receipt'
                    OR cp.metadata->>'is_sales_receipt_payment' = 'true')
               AND cp.status != 'voided'
             LIMIT 1`,
            [invoice_id]
        )

        if (!res.rows[0]) {
            logger.info(`${LOG_PREFIX} No SR payment found for invoice ${invoice_id} to void`)
            return
        }

        const payment = res.rows[0]
        await financeService.updateCustomerPayments({
            id: payment.id,
            status: 'voided',
            metadata: {
                ...(payment.metadata || {}),
                qb_sync_status: 'voided',
            },
            qb: {
                ...(payment.qb || {}),
                status: 'voided',
            },
        })
        logger.info(`${LOG_PREFIX} ✅ SR Payment ${payment.id} voided alongside Sales Receipt ${invoice_id}`)
    } catch (err: any) {
        logger.warn(`${LOG_PREFIX} ⚠️ Could not void SR payment for invoice ${invoice_id}: ${err.message}`)
    }
}
