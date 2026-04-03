import { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"
import { handleDraftOrderCreated } from "../../../../subscribers/qb-draft-order-subscriber"
import { handleOrderPlaced } from "../../../../lib/quickbooks/handlers/handle-order-placed"
import { handleFulfillmentCreated } from "../../../../lib/quickbooks/handlers/handle-fulfillment-created"
import { handleSalesReceiptCreated } from "../../../../lib/quickbooks/handlers/handle-sales-receipt-created"
import { handlePosPaymentCreated } from "../../../../lib/quickbooks/handlers/handle-pos-payment-created"
import { handlePosPaymentApplied } from "../../../../lib/quickbooks/handlers/handle-pos-payment-applied"
import { FINANCE_MODULE } from "../../../../modules/finance"
import { INVOICE_MODULE } from "../../../../modules/invoices"
import { getEstimateTxnId, getSoTxnId } from "../../../../lib/quickbooks/qb-metadata-types"

const LOG_PREFIX = "[POST /admin/pos/sync]"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
    const { type, id, action = "sync" } = req.body as { type?: string, id?: string, action?: "sync" | "void" }

    if (!type || !id) {
        return res.status(400).json({ error: "Missing type or id" })
    }

    logger.info(`${LOG_PREFIX} 🔥 Manual QB Action Executed: type=${type}, id=${id}, action=${action}`)

    try {
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
        const orderModule = req.scope.resolve(Modules.ORDER)
        const customerModule = req.scope.resolve(Modules.CUSTOMER)
        
        switch (type) {
            case "estimate": {
                // Fetch the draft order
                const { data: [order] } = await query.graph({
                    entity: "order",
                    fields: ["metadata"],
                    filters: { id }
                })
                
                if (!order) return res.status(404).json({ error: "Estimate not found" })
                if (action === 'void') {
                    if (!getEstimateTxnId(order.metadata || {})) {
                        return res.status(400).json({ error: "Cannot close: Estimate is not in QuickBooks." })
                    }
                    const pipelineStep = "close_estimate";
                    const estimateMedusaRef = (order.metadata as any)?.document_number ?? null
                    try {
                        await orderModule.updateOrders(id, { metadata: { ...(order.metadata || {}), qb_sync_status: "voiding" } })
                        const { writePipelineRow } = require('../../../../lib/quickbooks/qb-pipeline')
                        await writePipelineRow({
                            orderId: id,
                            step: pipelineStep,
                            status: "pending",
                            qbTxnId: getEstimateTxnId(order.metadata || {}),
                            medusaRefNumber: estimateMedusaRef,
                        })
                    } catch (e) {}
                    // QuickBooks doesn't natively support "VoidEstimate", but we can mark it inactive/sync status voided.
                    const { closeEstimateInQb } = require('../../../../lib/quickbooks/qb-bridge-client')
                    if (closeEstimateInQb) {
                        const qbTxnId = getEstimateTxnId(order.metadata || {});
                        closeEstimateInQb(qbTxnId, (m: string) => logger.info(m)).then(async (res: any) => {
                            try {
                                const { writePipelineRow } = require('../../../../lib/quickbooks/qb-pipeline')
                                if (res?.success) {
                                    await writePipelineRow({ orderId: id, step: pipelineStep, status: "submitted", bridgeOpId: res.data?.operationId, qbTxnId, medusaRefNumber: estimateMedusaRef })
                                } else {
                                    await writePipelineRow({ orderId: id, step: pipelineStep, status: "failed", error: res?.error, qbTxnId, medusaRefNumber: estimateMedusaRef })
                                }
                            } catch(e) {}
                        })
                    }
                    try {
                        const refreshed = await orderModule.retrieveOrder(id)
                        await orderModule.updateOrders(id, { metadata: { ...(refreshed.metadata || {}), qb_sync_status: "voided" } })
                    } catch (e) {}
                    return res.json({ success: true, message: "Estimate close logic executed" })
                }

                const estimateTxnId = getEstimateTxnId(order.metadata || {})
                const syncStatus    = order.metadata?.qb_sync_status as string | undefined
                const inFlight      = syncStatus && ['creating', 'editing', 'pending'].includes(syncStatus)

                // If Estimate already exists → Mod in the background, return immediately
                if (estimateTxnId) {
                    ;(async () => {
                        try {
                            const { buildQbItems, buildQbOrderDiscountLines } = require("../../../../lib/quickbooks/order-flow-core")
                            const { updateEstimateInQb } = require("../../../../lib/quickbooks/client/estimates")
                            const { cacheEditSequence } = require("../../../../lib/quickbooks/qb-pipeline")

                            const { data: [fullOrder] } = await query.graph({
                                entity: "order",
                                fields: [
                                    "id", "metadata", "tax_total", "subtotal", "discount_total",
                                    "items.*", "items.variant.*", "items.variant.metadata",
                                ],
                                filters: { id }
                            })

                            if (!fullOrder) throw new Error(`Order ${id} not found`)

                            const activeItems = (fullOrder.items || [])
                                .filter((item: any) => (item.quantity ?? 0) > 0)
                                .map((item: any) => ({ ...item, unit_price: Number(item.unit_price || 0), subtotal: undefined }))

                            const qbItems = buildQbItems(activeItems, fullOrder.metadata)

                            const discountTotal = Number(fullOrder.discount_total || 0)
                            if (discountTotal > 0) {
                                const subtotal = Number(fullOrder.subtotal || 0)
                                const pct = subtotal > 0 ? (discountTotal / subtotal) * 100 : null
                                buildQbOrderDiscountLines(discountTotal, pct).forEach((l: any) => qbItems.push(l))
                            }

                            const hasTax = fullOrder.tax_total && fullOrder.tax_total > 0

                            logger.info(`${LOG_PREFIX} Estimate already exists (${estimateTxnId}) — running EstimateMod with ${qbItems.length} items`)

                            const modResult = await updateEstimateInQb({
                                txnId: estimateTxnId,
                                items: qbItems,
                                ...(hasTax ? {} : { taxExempt: true }),
                            })

                            if (!modResult.success) {
                                logger.error(`${LOG_PREFIX} ❌ Estimate Mod failed: ${modResult.error}`)
                                return
                            }

                            if (modResult.data?.operationId) {
                                const { pollOperationResult } = require("../../../../lib/quickbooks/client/core")
                                const pollResult = await pollOperationResult(modResult.data.operationId)
                                if (pollResult.editSequence) {
                                    await cacheEditSequence("estimate", estimateTxnId, pollResult.editSequence)
                                    const refreshed = await orderModule.retrieveOrder(id)
                                    await orderModule.updateOrders(id, {
                                        metadata: {
                                            ...(refreshed.metadata || {}),
                                            qb_estimate: {
                                                ...((refreshed.metadata?.qb_estimate as object) || {}),
                                                edit_sequence: pollResult.editSequence,
                                            }
                                        }
                                    })
                                    logger.info(`${LOG_PREFIX} ✅ Estimate Mod confirmed — EditSeq=${pollResult.editSequence}`)
                                }
                            }
                        } catch (bgErr: any) {
                            logger.error(`${LOG_PREFIX} Background Estimate Mod error: ${bgErr.message}`)
                        }
                    })()

                    return res.json({ success: true, message: "Estimate update queued" })
                }

                if (inFlight) {
                    return res.status(400).json({ error: `Cannot sync: Estimate is already in progress (status: ${syncStatus}).` })
                }

                // Fire-and-forget — pass isCron=true to bypass the POS "delay 1h" guard
                handleDraftOrderCreated({ id }, req.scope, logger, true)
                    .catch((err: any) => logger.error(`${LOG_PREFIX} Background estimate sync error: ${err.message}`))
                return res.json({ success: true, message: "Estimate sync queued" })
            }

            case "order": {
                const { data: [order] } = await query.graph({
                    entity: "order",
                    fields: ["metadata", "items.*", "items.detail.*"],
                    filters: { id }
                })
                
                if (!order) return res.status(404).json({ error: "Order not found" })
                if (action === 'void') {
                    if (!getSoTxnId(order.metadata || {})) {
                        return res.status(400).json({ error: "Cannot close: Order is not in QuickBooks." })
                    }
                    try {
                        await orderModule.updateOrders(id, { metadata: { ...(order.metadata || {}), qb_sync_status: "voiding" } })
                    } catch (e) {}
                    const { handleOrderCanceled } = require("../../../../lib/quickbooks/handlers/handle-order-canceled")
                    await handleOrderCanceled({ id }, orderModule, logger)
                    // Optimistically set to voided or error depending on if it works
                    try {
                        const refreshed = await orderModule.retrieveOrder(id)
                        await orderModule.updateOrders(id, { metadata: { ...(refreshed.metadata || {}), qb_sync_status: "voided" } })
                    } catch (e) {}
                    return res.json({ success: true, message: "Order close logic executed" })
                }

                const soTxnId      = getSoTxnId(order.metadata || {})
                const soSyncStatus = order.metadata?.qb_sync_status as string | undefined
                // Only block on SO-specific in-progress states — "synced"/"child_synced" belongs to the Estimate, not SO
                const soInFlight   = soSyncStatus && ['creating', 'editing', 'pending'].includes(soSyncStatus)

                // If SO already exists → Mod (update) in the background, return immediately
                if (soTxnId) {
                    ;(async () => {
                        try {
                            const { buildQbItems, buildShippingQbItem, buildQbOrderDiscountLines } = require("../../../../lib/quickbooks/order-flow-core")
                            const { updateSalesOrderInQb } = require("../../../../lib/quickbooks/client/sales-orders")
                            const { getQbConfig } = require("../../../../lib/quickbooks/handlers/utils")
                            const { cacheEditSequence } = require("../../../../lib/quickbooks/qb-pipeline")
                            const { pollOperationResult } = require("../../../../lib/quickbooks/client/core")

                            const { data: [fullOrder] } = await query.graph({
                                entity: "order",
                                fields: [
                                    "id", "metadata", "tax_total", "subtotal", "discount_total",
                                    "customer_id", "customer.*", "customer.metadata",
                                    "items.*", "items.variant.*", "items.variant.metadata",
                                    "shipping_methods.*",
                                ],
                                filters: { id }
                            })

                            if (!fullOrder) throw new Error(`Order ${id} not found`)

                            const qbConfig = await getQbConfig()
                            const activeItems = (fullOrder.items || [])
                                .filter((item: any) => (item.quantity ?? 0) > 0)
                                .map((item: any) => ({ ...item, unit_price: Number(item.unit_price || 0), subtotal: undefined }))

                            const qbItems = buildQbItems(activeItems, fullOrder.metadata)

                            const discountTotal = Number(fullOrder.discount_total || 0)
                            if (discountTotal > 0) {
                                const subtotal = Number(fullOrder.subtotal || 0)
                                const pct = subtotal > 0 ? (discountTotal / subtotal) * 100 : null
                                buildQbOrderDiscountLines(discountTotal, pct).forEach((l: any) => qbItems.push(l))
                            }

                            const shippingItem = buildShippingQbItem(fullOrder.shipping_methods || [], qbConfig.shippingItemId)
                            if (shippingItem) qbItems.push(shippingItem)

                            const hasTax = fullOrder.tax_total && fullOrder.tax_total > 0
                            const salesTaxCode = hasTax ? qbConfig.defaultSalesTaxCode : undefined
                            const qbListId = (fullOrder.customer as any)?.metadata?.qb_list_id || fullOrder.metadata?.qb_list_id

                            logger.info(`${LOG_PREFIX} SO already exists (${soTxnId}) — running SalesOrderMod with ${qbItems.length} items`)

                            const modResult = await updateSalesOrderInQb({
                                txnId: soTxnId,
                                ...(qbListId ? { customerId: qbListId } : {}),
                                items: qbItems,
                                ...(salesTaxCode ? { salesTaxCode } : { taxExempt: true }),
                            })

                            if (!modResult.success) {
                                logger.error(`${LOG_PREFIX} ❌ SO Mod failed: ${modResult.error}`)
                                return
                            }

                            if (modResult.data?.operationId) {
                                const pollResult = await pollOperationResult(modResult.data.operationId)
                                if (pollResult.editSequence) {
                                    await cacheEditSequence("sales_order", soTxnId, pollResult.editSequence)
                                    const refreshed = await orderModule.retrieveOrder(id)
                                    await orderModule.updateOrders(id, {
                                        metadata: {
                                            ...(refreshed.metadata || {}),
                                            qb_sales_order: {
                                                ...((refreshed.metadata?.qb_sales_order as object) || {}),
                                                edit_sequence: pollResult.editSequence,
                                            }
                                        }
                                    })
                                    logger.info(`${LOG_PREFIX} ✅ SO Mod confirmed — EditSeq=${pollResult.editSequence}`)
                                }
                            }
                        } catch (bgErr: any) {
                            logger.error(`${LOG_PREFIX} Background SO Mod error: ${bgErr.message}`)
                        }
                    })()

                    return res.json({ success: true, message: "Sales Order update queued" })
                }

                // If metadata says in-flight, verify there is actually an active pipeline row.
                // If not, the status is stale (server restarted mid-operation) — allow retry.
                if (soInFlight) {
                    const { getDbPool } = require("../../../utils/db-pool")
                    const pool = getDbPool()
                    const { rows: activeRows } = await pool.query(
                        `SELECT id FROM qb_order_pipeline
                         WHERE order_id = $1 AND step = 'sales_order' AND status IN ('pending','submitted')
                         LIMIT 1`,
                        [id]
                    )
                    if (activeRows.length > 0) {
                        return res.status(400).json({ error: `Cannot sync: Sales Order is already in progress (status: ${soSyncStatus}).` })
                    }
                    // Stale state — clear it and allow retry
                    logger.warn(`${LOG_PREFIX} ⚠️ Stale qb_sync_status="${soSyncStatus}" with no active pipeline row — clearing and retrying`)
                    try {
                        await orderModule.updateOrders(id, { metadata: { ...(order.metadata || {}), qb_sync_status: null } })
                    } catch (e) {}
                }

                // Safety Lock: Check if fully or partially invoiced.
                // In POS, if "pos_invoice" exists for this order, we block the SO manual sync
                const { data: invoices } = await query.graph({
                    entity: "pos_invoice",
                    fields: ["id"],
                    filters: { order_id: id }
                })

                if (invoices && invoices.length > 0) {
                    return res.status(400).json({ error: "Cannot manual-sync Order: Products are already invoiced. Use Invoice manual sync instead to preserve accounting links." })
                }

                // isCron=true bypasses the POS 1-hour delay guard (manual sync = explicit override)
                handleOrderPlaced({ id }, orderModule, customerModule, req.scope, logger, true)
                    .catch((err: any) => logger.error(`${LOG_PREFIX} Background order sync error: ${err.message}`))
                return res.json({ success: true, message: "Sales Order sync queued" })
            }

            case "invoice": {
                const invoiceService = req.scope.resolve(INVOICE_MODULE)
                const invoice = await invoiceService.retrievePosInvoice(id)
                if (!invoice) return res.status(404).json({ error: "Invoice not found" })
                
                if (action === 'void') {
                    if (!invoice.metadata?.qb_txn_id && !invoice.metadata?.qb_ref_number && !invoice.metadata?.qb_invoice_txn_id && !invoice.metadata?.qb_sales_receipt_txn_id) {
                        return res.status(400).json({ error: "Cannot void: Invoice is not in QuickBooks." })
                    }
                    const { handleInvoiceVoided } = require("../../../../lib/quickbooks/handlers/handle-invoice-voided")
                    await handleInvoiceVoided({ order_id: invoice.order_id, invoice_id: id }, orderModule, logger, req.scope)
                    return res.json({ success: true, message: "Invoice void logic executed" })
                }
                
                const invTxnId = invoice.metadata?.qb_txn_id || invoice.metadata?.qb_ref_number
                    || invoice.metadata?.qb_invoice_txn_id || invoice.metadata?.qb_sales_receipt_txn_id
                if (invTxnId) {
                    // Already in QB → fetch + cache EditSequence in background
                    ;(async () => {
                        try {
                            const { bridgeFetch, pollRawOperationResult } = require("../../../../lib/quickbooks/client/core")
                            const { cacheEditSequence } = require("../../../../lib/quickbooks/qb-pipeline")
                            const isSR = !!(invoice.metadata?.qb_sales_receipt_txn_id
                                || invoice.metadata?.is_sales_receipt === true
                                || invoice.metadata?.is_sales_receipt === "true")
                            const endpoint = isSR ? "sales-receipts" : "invoices"
                            const entityType = isSR ? "sales_receipt" : "invoice"
                            const resp = await bridgeFetch("GET", `/api/${endpoint}/${invTxnId}`)
                            if (!resp?.operationId) return
                            const raw = await pollRawOperationResult(resp.operationId)
                            const editSeq =
                                raw?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet?.EditSequence ||
                                raw?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet?.EditSequence ||
                                raw?.InvoiceRet?.EditSequence ||
                                raw?.QBXML?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet?.EditSequence ||
                                raw?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet?.EditSequence ||
                                raw?.SalesReceiptRet?.EditSequence
                            if (editSeq) {
                                await cacheEditSequence(entityType, invTxnId, String(editSeq))
                                logger.info(`${LOG_PREFIX} ✅ Cached EditSeq for ${entityType} ${invTxnId}: ${editSeq}`)
                            }
                        } catch (bgErr: any) {
                            logger.warn(`${LOG_PREFIX} ⚠️ Could not refresh invoice EditSeq: ${bgErr.message}`)
                        }
                    })()
                    return res.json({ success: true, message: "Invoice already in QuickBooks — EditSequence refresh queued" })
                }

                const { data: [order] } = await query.graph({
                    entity: "order",
                    fields: ["metadata", "customer_id", "status"],
                    filters: { id: invoice.order_id }
                })

                // Block if order is already mid-sync (creating/pending) — prevents duplicate invoice
                const orderSyncStatus = order?.metadata?.qb_sync_status as string | undefined
                if (orderSyncStatus === "creating") {
                    return res.status(400).json({ error: "Cannot sync: Order sync is still in progress. Wait for it to complete." })
                }

                const soTxnId = getSoTxnId(order?.metadata || {})
                
                // INTELLIGENT ROUTING
                if (soTxnId) {
                    // Scenario 1: Order -> Invoice (LinkToTxn)
                    logger.info(`${LOG_PREFIX} Intelligent Sync -> Has Sales Order -> Dispatching InvoiceAdd`)
                    handleFulfillmentCreated(
                        { order_id: invoice.order_id, fulfillment_id: invoice.fulfillment_id, invoice_id: id },
                        orderModule,
                        customerModule,
                        req.scope,
                        logger
                    ).catch((err: any) => logger.error(`${LOG_PREFIX} Background invoice sync error: ${err.message}`))
                    return res.json({ success: true, message: "InvoiceAdd queued" })
                } else {
                    // Scenario 2: Direct POS Sale
                    logger.info(`${LOG_PREFIX} Intelligent Sync -> No Sales Order -> Dispatching SalesReceiptAdd`)
                    handleSalesReceiptCreated(
                        { order_id: invoice.order_id, fulfillment_id: invoice.fulfillment_id, invoice_id: id },
                        orderModule,
                        customerModule,
                        req.scope,
                        logger
                    ).catch((err: any) => logger.error(`${LOG_PREFIX} Background sales receipt sync error: ${err.message}`))
                    return res.json({ success: true, message: "SalesReceiptAdd queued" })
                }
            }

            case "payment": {
                const financeService = req.scope.resolve(FINANCE_MODULE)
                const payment = await financeService.retrieveCustomerPayment(id, { relations: ["applications"] })
                if (!payment) return res.status(404).json({ error: "Payment not found" })
                
                const payTxnId      = payment.metadata?.qb_txn_id as string | undefined
                const paySyncStatus = payment.metadata?.qb_sync_status as string | undefined
                const payInFlight   = paySyncStatus && ['creating', 'editing', 'pending'].includes(paySyncStatus)
                if (payTxnId) {
                    // Already in QB → fetch + cache EditSequence in background
                    ;(async () => {
                        try {
                            const { bridgeFetch, pollRawOperationResult } = require("../../../../lib/quickbooks/client/core")
                            const { cacheEditSequence } = require("../../../../lib/quickbooks/qb-pipeline")
                            const resp = await bridgeFetch("GET", `/api/payments/${payTxnId}`)
                            if (!resp?.operationId) return
                            const raw = await pollRawOperationResult(resp.operationId)
                            const editSeq =
                                raw?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet?.EditSequence ||
                                raw?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet?.EditSequence ||
                                raw?.ReceivePaymentRet?.EditSequence
                            if (editSeq) {
                                await cacheEditSequence("payment", payTxnId, String(editSeq))
                                logger.info(`${LOG_PREFIX} ✅ Cached EditSeq for payment ${payTxnId}: ${editSeq}`)
                            }
                        } catch (bgErr: any) {
                            logger.warn(`${LOG_PREFIX} ⚠️ Could not refresh payment EditSeq: ${bgErr.message}`)
                        }
                    })()
                    return res.json({ success: true, message: "Payment already in QuickBooks — EditSequence refresh queued" })
                }
                if (payInFlight) {
                    return res.status(400).json({ error: `Cannot sync: Payment is already in progress (status: ${paySyncStatus}).` })
                }

                // Fire-and-forget — double sequence runs in background
                ;(async () => {
                    try {
                        logger.info(`${LOG_PREFIX} Sequence 1/2: handlePosPaymentCreated`)
                        await handlePosPaymentCreated({
                            event: { name: 'pos.payment.created', data: { id } },
                            container: req.scope as any,
                            pluginOptions: {}
                        })
                        const refreshedPayment = await financeService.retrieveCustomerPayment(id, { relations: ["applications"] })
                        if (refreshedPayment.applications?.length > 0) {
                            logger.info(`${LOG_PREFIX} Sequence 2/2: handlePosPaymentApplied`)
                            for (const app of refreshedPayment.applications) {
                                if (app.invoice_id) {
                                    await handlePosPaymentApplied({
                                        event: { name: 'pos.payment.applied', data: { payment_id: refreshedPayment.id, invoice_id: app.invoice_id, order_id: app.order_id, amount_applied: Number(app.amount_applied) } },
                                        container: req.scope as any,
                                        pluginOptions: {}
                                    })
                                }
                            }
                        } else {
                            logger.info(`${LOG_PREFIX} Sequence 2/2 skipped: No payment applications found`)
                        }
                    } catch (err: any) {
                        logger.error(`${LOG_PREFIX} Background payment sync error: ${err.message}`)
                    }
                })()
                return res.json({ success: true, message: "Payment sync queued" })
            }

            case "return": {
                const financeService = req.scope.resolve(FINANCE_MODULE)
                const payment = await financeService.retrieveCustomerPayment(id)
                // In our POS, Refunds are Customer Payments with type = 'refund'
                if (!payment || payment.type !== "refund") return res.status(404).json({ error: "Refund not found" })
                
                if (payment.metadata?.qb_txn_id) {
                    // Already in QB → fetch + cache EditSequence in background
                    const refundTxnId = payment.metadata.qb_txn_id as string
                    ;(async () => {
                        try {
                            const { bridgeFetch, pollRawOperationResult } = require("../../../../lib/quickbooks/client/core")
                            const { cacheEditSequence } = require("../../../../lib/quickbooks/qb-pipeline")
                            const resp = await bridgeFetch("GET", `/api/checks/${refundTxnId}`)
                            if (!resp?.operationId) return
                            const raw = await pollRawOperationResult(resp.operationId)
                            const editSeq =
                                raw?.QBXML?.QBXMLMsgsRs?.CheckQueryRs?.CheckRet?.EditSequence ||
                                raw?.QBXMLMsgsRs?.CheckQueryRs?.CheckRet?.EditSequence ||
                                raw?.CheckRet?.EditSequence
                            if (editSeq) {
                                await cacheEditSequence("write_check", refundTxnId, String(editSeq))
                                logger.info(`${LOG_PREFIX} ✅ Cached EditSeq for write_check ${refundTxnId}: ${editSeq}`)
                            }
                        } catch (bgErr: any) {
                            logger.warn(`${LOG_PREFIX} ⚠️ Could not refresh refund EditSeq: ${bgErr.message}`)
                        }
                    })()
                    return res.json({ success: true, message: "Refund already in QuickBooks — EditSequence refresh queued" })
                }
                
                handlePosPaymentCreated({
                    event: { name: 'pos.payment.created', data: { id } },
                    container: req.scope as any,
                    pluginOptions: {}
                }).catch((err: any) => logger.error(`${LOG_PREFIX} Background refund sync error: ${err.message}`))
                return res.json({ success: true, message: "Refund/CreditMemo sync queued" })
            }

            case "credit_memo": {
                const creditMemoService = req.scope.resolve('credit_memos') as any
                const creditMemo = await creditMemoService.retrievePosCreditMemo(id, { relations: ["items"] })
                if (!creditMemo) return res.status(404).json({ error: "Credit Memo not found" })

                // Smart void retry: if CM is voided and has a QB TxnID, re-send void to QB (background)
                if (creditMemo.status === 'voided' || action === 'void') {
                    if (!creditMemo.qb_txn_id) {
                        return res.status(400).json({ error: "Cannot void in QB: Credit Memo was never synced to QuickBooks." })
                    }
                    logger.info(`${LOG_PREFIX} Retrying QB void for Credit Memo ${creditMemo.credit_memo_number} (TxnID: ${creditMemo.qb_txn_id})`)
                    ;(async () => {
                        try {
                            const { voidCreditMemoInQb } = require('../../../../lib/quickbooks/client/credit-memos')
                            const { writePipelineRow } = require('../../../../lib/quickbooks/qb-pipeline')
                            
                            try {
                                const qb_ref_number = creditMemo.metadata?.qb_ref_number || creditMemo.credit_memo_number || null;
                                await writePipelineRow({
                                    referenceId:     id,
                                    referenceType:   "credit_memo",
                                    step:            "void_credit_memo",
                                    status:          "pending",
                                    qbTxnId:         creditMemo.qb_txn_id,
                                    qbRefNumber:     qb_ref_number,
                                    medusaRefNumber: creditMemo.credit_memo_number || null,
                                })
                            } catch (pErr: any) {
                                logger.warn(`${LOG_PREFIX} ⚠️ Could not write pre-flight pipeline row: ${pErr.message}`)
                            }

                            const result = await voidCreditMemoInQb(
                                creditMemo.qb_txn_id,
                                creditMemo.qb_edit_sequence,
                                (msg: string) => logger.info(msg)
                            )
                            if (result.success) {
                                await writePipelineRow({
                                    referenceId:     id,
                                    referenceType:   "credit_memo",
                                    step:            "void_credit_memo",
                                    status:          "submitted",
                                    bridgeOpId:      result.data?.operationId || null,
                                    qbTxnId:         creditMemo.qb_txn_id,
                                    qbRefNumber:     creditMemo.qb_ref_number ?? creditMemo.credit_memo_number ?? null,
                                    medusaRefNumber: creditMemo.credit_memo_number ?? null,
                                })
                                logger.info(`${LOG_PREFIX} ✅ QB void retry succeeded for ${creditMemo.credit_memo_number}`)
                            } else {
                                logger.error(`${LOG_PREFIX} ❌ QB void retry failed: ${result.error}`)
                            }
                        } catch (bgErr: any) {
                            logger.error(`${LOG_PREFIX} QB void retry error: ${bgErr.message}`)
                        }
                    })()
                    return res.json({ success: true, message: "Credit Memo void queued to QuickBooks" })
                }

                if (creditMemo.status !== 'completed') return res.status(400).json({ error: "Only completed credit memos can be synced to QuickBooks." })

                const cmTxnId = creditMemo.metadata?.qb_txn_id as string | undefined
                if (cmTxnId) {
                    // Already in QB → fetch + cache EditSequence in background
                    ;(async () => {
                        try {
                            const { bridgeFetch, pollRawOperationResult } = require("../../../../lib/quickbooks/client/core")
                            const { cacheEditSequence } = require("../../../../lib/quickbooks/qb-pipeline")
                            const resp = await bridgeFetch("GET", `/api/credit-memos/${cmTxnId}`)
                            if (!resp?.operationId) return
                            const raw = await pollRawOperationResult(resp.operationId)
                            const editSeq =
                                raw?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet?.EditSequence ||
                                raw?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet?.EditSequence ||
                                raw?.CreditMemoRet?.EditSequence
                            if (editSeq) {
                                await cacheEditSequence("credit_memo", cmTxnId, String(editSeq))
                                logger.info(`${LOG_PREFIX} ✅ Cached EditSeq for credit_memo ${cmTxnId}: ${editSeq}`)
                            }
                        } catch (bgErr: any) {
                            logger.warn(`${LOG_PREFIX} ⚠️ Could not refresh credit memo EditSeq: ${bgErr.message}`)
                        }
                    })()
                    return res.json({ success: true, message: "Credit Memo already in QuickBooks — EditSequence refresh queued" })
                }

                const customerModule = req.scope.resolve(Modules.CUSTOMER)
                let customer
                try {
                    customer = await customerModule.retrieveCustomer(creditMemo.customer_id, { relations: ["addresses"] })
                } catch {
                    return res.status(404).json({ error: "Customer not found for this Credit Memo." })
                }
                
                const { ensureCustomerInQb } = require('../../../../lib/quickbooks/order-flow-core')
                const custResult: any = await ensureCustomerInQb(customer, customerModule, (m: string) => logger.info(m))
                
                if (!custResult.success || !custResult.qbCustomerId) {
                    return res.status(500).json({ error: "Failed to ensure customer in QuickBooks" })
                }
                
                const qbItems = creditMemo.items.map((item: any) => ({
                    productId: item.variant_id || item.product_id,
                    productName: item.title,
                    quantity: item.quantity,
                    price: item.unit_price,
                    amount: item.quantity * item.unit_price,
                    desc: item.title
                }))

                const { createCreditMemoInQb } = require('../../../../lib/quickbooks/client')
                const cmResult = await createCreditMemoInQb({
                    customerId: custResult.qbCustomerId,
                    date: creditMemo.completed_at ? new Date(creditMemo.completed_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                    refNumber: creditMemo.credit_memo_number ? `CM-${creditMemo.credit_memo_number}` : `CM-${creditMemo.id.slice(-6)}`,
                    memo: `Medusa POS Credit Memo`,
                    items: qbItems
                })
                
                if (!cmResult.success) {
                    return res.status(500).json({ error: cmResult.error || "Failed to create Credit Memo in QuickBooks" })
                }
                
                return res.json({ success: true, message: "Credit Memo sync queued successfully" })
            }

            default:
                return res.status(400).json({ error: `Unknown type: ${type}` })
        }
    } catch (err: any) {
        logger.error(`${LOG_PREFIX} Error during manual sync: ${err.message}`)
        return res.status(500).json({ error: err.message })
    }
}
