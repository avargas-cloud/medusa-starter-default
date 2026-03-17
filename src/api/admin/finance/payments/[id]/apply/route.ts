import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { markPaymentCollectionAsPaid } from "@medusajs/core-flows"
import { FINANCE_MODULE } from '../../../../../../modules/finance'
import { INVOICE_MODULE } from '../../../../../../modules/invoices'

/**
 * POST /admin/finance/payments/:id/apply
 * Applies an available CustomerPayment to a specific invoice.
 * This also triggers the creation of an InvoicePayment on the target invoice.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const paymentId = req.params.id!
    const { invoice_id, amount_applied, applied_by } = req.body as any
    
    if (!invoice_id) {
        return res.status(400).json({ error: 'invoice_id is required' })
    }
    if (!amount_applied || amount_applied <= 0) {
        return res.status(400).json({ error: 'amount_applied must be a positive number' })
    }

    const financeService = req.scope.resolve(FINANCE_MODULE)
    const invoiceService = req.scope.resolve(INVOICE_MODULE)

    try {
        // 1. Fetch the CustomerPayment with its current applications
        const payment = await financeService.retrieveCustomerPayment(paymentId, {
            relations: ['applications']
        })
        
        if (!payment) {
            return res.status(404).json({ error: 'Customer payment not found' })
        }
        
        if (payment.status === 'voided') {
            return res.status(400).json({ error: 'Cannot apply a voided payment' })
        }
        
        if (payment.source === 'web') {
            return res.status(403).json({ error: 'Web checkout payments are automatically applied to their source orders and cannot be manually applied to invoices.' })
        }

        // Calculate available balance
        const totalApplied = payment.applications
            .filter((app: any) => !app.voided_at)
            .reduce((sum: number, app: any) => sum + Number(app.amount_applied), 0)
            
        const availableAmount = Number(payment.amount) - totalApplied
        
        if (amount_applied > availableAmount) {
            return res.status(400).json({ 
                error: `Requested amount (${amount_applied}) exceeds available payment balance (${availableAmount})` 
            })
        }

        // 2. Fetch the target invoice to get order_id and ensure it exists
        const invoice = await invoiceService.retrievePosInvoice(invoice_id)
        if (!invoice) {
            return res.status(404).json({ error: 'Target invoice not found' })
        }
        if (invoice.status === 'voided') {
            return res.status(400).json({ error: 'Cannot apply payment to a voided invoice' })
        }

        // 3. Create the PaymentApplication record in Finance module
        const application = await financeService.createPaymentApplications({
            payment_id: paymentId,
            invoice_id: invoice_id,
            order_id: invoice.order_id,
            amount_applied,
            applied_at: new Date(),
            applied_by: applied_by || null
        })

        // 4. Update the CustomerPayment status
        const isFullyApplied = (totalApplied + Number(amount_applied)) >= Number(payment.amount)
        const newPaymentStatus = isFullyApplied ? 'applied' : 'partially_applied'
        
        if (payment.status !== newPaymentStatus) {
            await financeService.updateCustomerPayments({
                id: paymentId,
                status: newPaymentStatus
            })
        }

        // 5. Create the corresponding InvoicePayment in the Invoice module
        await invoiceService.createInvoicePayments({
            invoice_id: invoice_id,
            amount: amount_applied,
            payment_method: 'credit', // In the context of the invoice, the method is "customer credit"
            notes: `Applied from deposit/payment ${payment.reference || paymentId}`,
            created_by: applied_by || null,
            paid_at: new Date()
        })

        // 6. Recalculate invoice totals and status
        const allInvoicePayments = await invoiceService.listInvoicePayments({ invoice_id: invoice_id })
        const totalInvoicePaid = allInvoicePayments.reduce((sum: number, p: any) => sum + Number(p.amount), 0)
        const balanceDue = Math.max(0, Number(invoice.total) - totalInvoicePaid)
        const newInvoiceStatus = balanceDue <= 0 ? 'paid' : 'partial'

        await invoiceService.updatePosInvoices(
            { id: invoice_id },
            { amount_paid: totalInvoicePaid, balance_due: balanceDue, status: newInvoiceStatus }
        )

        // 7. Mark native payment collection as paid if invoice is fully paid
        if (newInvoiceStatus === 'paid' && invoice.order_id) {
            try {
                const query = req.scope.resolve("query")
                const { data: [order] } = await query.graph({
                    entity: 'order',
                    fields: ['payment_collections.*'],
                    filters: { id: invoice.order_id }
                })
                
                const pcId = order?.payment_collections?.[0]?.id
                if (pcId) {
                    await markPaymentCollectionAsPaid(req.scope).run({
                        input: { order_id: invoice.order_id, payment_collection_id: pcId }
                    })
                }
            } catch (err: any) {
                req.scope.resolve('logger').warn(`[Medusa Native] Failed to mark order payment collection as paid (${invoice.order_id}): ` + err.message)
            }
        }

        // Refetch updated payment for response
        const updatedPayment = await financeService.retrieveCustomerPayment(paymentId, {
            relations: ['applications']
        })

        return res.json({ payment: updatedPayment, application })
        
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
