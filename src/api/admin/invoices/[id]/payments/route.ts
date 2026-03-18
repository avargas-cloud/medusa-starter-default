/**
 * POST /admin/invoices/:id/payments  — record a payment against an invoice
 * GET  /admin/invoices/:id/payments  — list all payments for an invoice
 *
 * On POST, the route:
 *   1. Creates an invoice_payment record
 *   2. Re-sums all payments and updates pos_invoice.amount_paid + balance_due
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../../../modules/invoices'
import { FINANCE_MODULE } from '../../../../../modules/finance'
import { registerMedusaPayment } from '../../register-medusa-payment'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const id = req.params.id!
    const invoiceService = req.scope.resolve(INVOICE_MODULE)

    try {
        const payments = await invoiceService.listInvoicePayments(
            { invoice_id: id },
            { order: { paid_at: 'DESC' } }
        )
        return res.json({ payments })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const id = req.params.id!
    const { amount, payment_method, notes, created_by, paid_at, customer_id, reference } = req.body as any
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const financeService = req.scope.resolve(FINANCE_MODULE)

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number (cents)' })
    }
    if (!payment_method) {
        return res.status(400).json({ error: 'payment_method is required' })
    }
    if (!customer_id) {
        return res.status(400).json({ error: 'customer_id is required. All payments must be linked to a customer ledger.' })
    }

    try {
        // 1. Load the invoice to verify it exists and isn't voided
        const invoice = await invoiceService.retrievePosInvoice(id)
        if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
        if (invoice.status === 'voided') {
            return res.status(400).json({ error: 'Cannot add payment to a voided invoice' })
        }

        const paymentDate = paid_at ? new Date(paid_at) : new Date()

        function mapPosMethodToDbEnum(method: string): any {
            if (['visa', 'mastercard', 'discover', 'amex', 'capital_one', 'debit_card'].includes(method)) return 'card';
            if (['e_check', 'checking_account', 'transfer', 'wire_transfer'].includes(method)) return 'ach';
            if (['paypal', 'money_order'].includes(method)) return 'other';
            if (method === 'credit') return 'credit_memo';
            if (['cash', 'check', 'zelle'].includes(method)) return method;
            return 'other';
        }

        // 2. Create the CustomerPayment (The core AR ledger entry)
        const customerPayment = await financeService.createCustomerPayments({
            customer_id,
            amount,
            method: mapPosMethodToDbEnum(payment_method),
            reference: reference || null,
            notes: notes || null,
            received_at: paymentDate,
            created_by: created_by || null,
            source: 'pos',
            type: 'payment',
            status: 'applied', // Immediately applied to this invoice
            medusa_payment_synced: false, // will be updated after Medusa sync
        })

        // 3. Create the PaymentApplication linking the payment to the invoice
        await financeService.createPaymentApplications({
            payment_id: customerPayment.id,
            invoice_id: id,
            order_id: invoice.order_id,
            amount_applied: amount,
            applied_at: paymentDate,
            applied_by: created_by || null
        })

        // 4. Create the historic InvoicePayment record
        await invoiceService.createInvoicePayments({
            invoice_id: id,
            amount,
            payment_method,
            notes: notes ?? null,
            created_by: created_by ?? null,
            paid_at: paymentDate,
        })

        // 5. Re-sum all payments and update the invoice status
        const allPayments = await invoiceService.listInvoicePayments({ invoice_id: id })
        const totalPaid = allPayments.reduce((sum: number, p: any) => sum + Number(p.amount), 0)
        const balanceDue = Math.max(0, Number(invoice.total) - totalPaid)
        const newStatus = balanceDue <= 0 ? 'paid' : 'partial'

        await invoiceService.updatePosInvoices(
            { id },
            { amount_paid: totalPaid, balance_due: balanceDue, status: newStatus }
        )

        // 6. Register in Medusa native Payment Module (best-effort, every payment)
        const medusaPaymentId = await registerMedusaPayment(req.scope, {
            order_id:       invoice.order_id,
            amount,
            payment_method,
            invoice_total:  Number(invoice.total),
        })
        if (medusaPaymentId) {
            await financeService.updateCustomerPayments(
                { id: customerPayment.id },
                { medusa_payment_synced: true }
            ).catch(() => {}) // non-fatal
        }

        const updated = await invoiceService.retrievePosInvoice(id)
        return res.json({ invoice: updated, payments: allPayments, customer_payment: customerPayment })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
