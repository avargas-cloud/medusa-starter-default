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
                    try {
                        await orderModule.updateOrders(id, { metadata: { ...(order.metadata || {}), qb_sync_status: "voiding" } })
                    } catch (e) {}
                    // QuickBooks doesn't natively support "VoidEstimate", but we can mark it inactive/sync status voided.
                    const { closeEstimateInQb } = require('../../../../../lib/quickbooks/qb-bridge-client')
                    if (closeEstimateInQb) {
                        await closeEstimateInQb(getEstimateTxnId(order.metadata || {}), (m: string) => logger.info(m))
                    }
                    try {
                        const refreshed = await orderModule.retrieveOrder(id)
                        await orderModule.updateOrders(id, { metadata: { ...(refreshed.metadata || {}), qb_sync_status: "voided" } })
                    } catch (e) {}
                    return res.json({ success: true, message: "Estimate close logic executed" })
                }

                const estimateTxnId = getEstimateTxnId(order.metadata || {})
                const syncStatus   = order.metadata?.qb_sync_status as string | undefined
                const inFlight     = syncStatus && syncStatus !== "error" && syncStatus !== "voided"
                if (estimateTxnId || inFlight) {
                    const reason = estimateTxnId
                        ? "Estimate is already confirmed in QuickBooks."
                        : `Estimate is already in progress (status: ${syncStatus}).`
                    return res.status(400).json({ error: `Cannot sync: ${reason}` })
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
                    const { handleOrderCanceled } = require("../../../../../lib/quickbooks/handlers/handle-order-canceled")
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
                const soInFlight   = soSyncStatus && soSyncStatus !== "error" && soSyncStatus !== "voided"
                if (soTxnId || soInFlight) {
                    const reason = soTxnId
                        ? "Sales Order is already confirmed in QuickBooks."
                        : `Sales Order is already in progress (status: ${soSyncStatus}).`
                    return res.status(400).json({ error: `Cannot sync: ${reason}` })
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

                handleOrderPlaced({ id }, orderModule, customerModule, req.scope, logger, false)
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
                    const { handleInvoiceVoided } = require("../../../../../lib/quickbooks/handlers/handle-invoice-voided")
                    await handleInvoiceVoided({ order_id: invoice.order_id, invoice_id: id }, orderModule, logger)
                    return res.json({ success: true, message: "Invoice void logic executed" })
                }
                
                const invTxnId = invoice.metadata?.qb_txn_id || invoice.metadata?.qb_ref_number
                    || invoice.metadata?.qb_invoice_txn_id || invoice.metadata?.qb_sales_receipt_txn_id
                if (invTxnId) {
                    return res.status(400).json({ error: "Cannot sync: Invoice is already in QuickBooks." })
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
                const payInFlight   = paySyncStatus && paySyncStatus !== "error" && paySyncStatus !== "voided"
                if (payTxnId || payInFlight) {
                    const reason = payTxnId
                        ? "Payment is already confirmed in QuickBooks."
                        : `Payment is already in progress (status: ${paySyncStatus}).`
                    return res.status(400).json({ error: `Cannot sync: ${reason}` })
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
                    return res.status(400).json({ error: "Cannot sync: Refund is already in QuickBooks." })
                }
                
                handlePosPaymentCreated({
                    event: { name: 'pos.payment.created', data: { id } },
                    container: req.scope as any,
                    pluginOptions: {}
                }).catch((err: any) => logger.error(`${LOG_PREFIX} Background refund sync error: ${err.message}`))
                return res.json({ success: true, message: "Refund/CreditMemo sync queued" })
            }

            case "credit_memo": {
                const creditMemoService = req.scope.resolve('creditMemoModuleService') as any
                const creditMemo = await creditMemoService.retrievePosCreditMemo(id, { relations: ["items"] })
                if (!creditMemo) return res.status(404).json({ error: "Credit Memo not found" })
                if (creditMemo.status !== 'completed') return res.status(400).json({ error: "Only completed credit memos can be synced to QuickBooks." })
                
                const customerModule = req.scope.resolve(Modules.CUSTOMER)
                let customer
                try {
                    customer = await customerModule.retrieveCustomer(creditMemo.customer_id, { relations: ["addresses"] })
                } catch {
                    return res.status(404).json({ error: "Customer not found for this Credit Memo." })
                }
                
                const { ensureCustomerInQb } = require('../../../../../../lib/quickbooks/order-flow-core')
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

                const { createCreditMemoInQb } = require('../../../../../../lib/quickbooks/client')
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
