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
    const { type, id } = req.body as { type?: string, id?: string }

    if (!type || !id) {
        return res.status(400).json({ error: "Missing type or id" })
    }

    logger.info(`${LOG_PREFIX} 🔥 Manual QB Sync Executed: type=${type}, id=${id}`)

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
                if (getEstimateTxnId(order.metadata || {})) {
                    return res.status(400).json({ error: "Cannot sync: Estimate is already in QuickBooks." })
                }
                
                // Force sync!
                await handleDraftOrderCreated({ id }, req.scope, logger, false)
                return res.json({ success: true, message: "Estimate sync queued" })
            }

            case "order": {
                const { data: [order] } = await query.graph({
                    entity: "order",
                    fields: ["metadata", "items.*", "items.detail.*"],
                    filters: { id }
                })
                
                if (!order) return res.status(404).json({ error: "Order not found" })
                if (getSoTxnId(order.metadata || {})) {
                    return res.status(400).json({ error: "Cannot sync: Order is already in QuickBooks." })
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

                await handleOrderPlaced({ id }, orderModule, customerModule, req.scope, logger, false)
                return res.json({ success: true, message: "Sales Order sync queued" })
            }

            case "invoice": {
                const invoiceService = req.scope.resolve(INVOICE_MODULE)
                const invoice = await invoiceService.retrievePosInvoice(id)
                if (!invoice) return res.status(404).json({ error: "Invoice not found" })
                
                if (invoice.metadata?.qb_txn_id || invoice.metadata?.qb_ref_number) {
                    return res.status(400).json({ error: "Cannot sync: Invoice is already in QuickBooks." })
                }
                
                const { data: [order] } = await query.graph({
                    entity: "order",
                    fields: ["metadata", "customer_id", "status"],
                    filters: { id: invoice.order_id }
                })
                
                const soTxnId = getSoTxnId(order?.metadata || {})
                
                // INTELLIGENT ROUTING
                if (soTxnId) {
                    // Scenario 1: Order -> Invoice (LinkToTxn)
                    logger.info(`${LOG_PREFIX} Intelligent Sync -> Has Sales Order -> Dispatching InvoiceAdd`)
                    await handleFulfillmentCreated(
                        { order_id: invoice.order_id, fulfillment_id: invoice.fulfillment_id, invoice_id: id },
                        orderModule,
                        customerModule,
                        req.scope,
                        logger
                    )
                    return res.json({ success: true, message: "InvoiceAdd via handleFulfillmentCreated queued" })
                } else {
                    // Scenario 2: Direct POS Sale
                    // Verify if it is fully paid. If the user clicks manual sync on an invoice, usually they want to force it.
                    logger.info(`${LOG_PREFIX} Intelligent Sync -> No Sales Order -> Dispatching SalesReceiptAdd`)
                    await handleSalesReceiptCreated(
                        { order_id: invoice.order_id, fulfillment_id: invoice.fulfillment_id, invoice_id: id },
                        orderModule,
                        customerModule,
                        req.scope,
                        logger
                    )
                    return res.json({ success: true, message: "SalesReceiptAdd queued" })
                }
            }

            case "payment": {
                const financeService = req.scope.resolve(FINANCE_MODULE)
                const payment = await financeService.retrieveCustomerPayment(id, { relations: ["applications"] })
                if (!payment) return res.status(404).json({ error: "Payment not found" })
                
                if (payment.metadata?.qb_txn_id) {
                    return res.status(400).json({ error: "Cannot sync: Payment is already in QuickBooks." })
                }
                
                // DOUBLE SEQUENCE:
                // 1. Create it in QB (ReceivePaymentAdd or Generic Refund)
                logger.info(`${LOG_PREFIX} Sequence 1/2: handlePosPaymentCreated (Creates TxnID in QB)`)
                await handlePosPaymentCreated({ 
                    event: { name: 'pos.payment.created', data: { id } }, 
                    container: req.scope as any,
                    pluginOptions: {}
                })
                
                // 2. Apply it for each application if it has a TxnID now
                // Re-fetch to get the new qb_txn_id
                const refreshedPayment = await financeService.retrieveCustomerPayment(id, { relations: ["applications"] })
                
                if (refreshedPayment.applications && refreshedPayment.applications.length > 0) {
                    logger.info(`${LOG_PREFIX} Sequence 2/2: handlePosPaymentApplied (Applying to invoice)`)
                    for (const app of refreshedPayment.applications) {
                        if (app.invoice_id) { 
                            await handlePosPaymentApplied({
                                event: { 
                                    name: 'pos.payment.applied', 
                                    data: { 
                                        payment_id: refreshedPayment.id, 
                                        invoice_id: app.invoice_id, 
                                        order_id: app.order_id, 
                                        amount_applied: Number(app.amount_applied) 
                                    } 
                                },
                                container: req.scope as any,
                                pluginOptions: {}
                            })
                        }
                    }
                } else {
                    logger.info(`${LOG_PREFIX} Sequence 2/2 skipped: No payment applications found`)
                }
                
                return res.json({ success: true, message: "Payment created and application queued sequentially" })
            }

            case "return": {
                const financeService = req.scope.resolve(FINANCE_MODULE)
                const payment = await financeService.retrieveCustomerPayment(id)
                // In our POS, Refunds are Customer Payments with type = 'refund'
                if (!payment || payment.type !== "refund") return res.status(404).json({ error: "Refund not found" })
                
                if (payment.metadata?.qb_txn_id) {
                    return res.status(400).json({ error: "Cannot sync: Refund is already in QuickBooks." })
                }
                
                await handlePosPaymentCreated({ 
                    event: { name: 'pos.payment.created', data: { id } }, 
                    container: req.scope as any,
                    pluginOptions: {}
                })
                
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
