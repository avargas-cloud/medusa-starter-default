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

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const { id } = req.params
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
    const { id } = req.params
    const { amount, payment_method, notes, created_by, paid_at } = req.body as any
    const invoiceService = req.scope.resolve(INVOICE_MODULE)

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number (cents)' })
    }
    if (!payment_method) {
        return res.status(400).json({ error: 'payment_method is required' })
    }

    try {
        // Load the invoice to verify it exists and isn't voided
        const invoice = await invoiceService.retrievePosInvoice(id)
        if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
        if (invoice.status === 'voided') {
            return res.status(400).json({ error: 'Cannot add payment to a voided invoice' })
        }

        // Create the payment record
        await invoiceService.createInvoicePayments({
            invoice_id: id,
            amount,
            payment_method,
            notes: notes ?? null,
            created_by: created_by ?? null,
            paid_at: paid_at ? new Date(paid_at) : new Date(),
        })

        // Re-sum all payments and update the invoice
        const allPayments = await invoiceService.listInvoicePayments({ invoice_id: id })
        const totalPaid = allPayments.reduce((sum: number, p: any) => sum + Number(p.amount), 0)
        const balanceDue = Math.max(0, Number(invoice.total) - totalPaid)
        const newStatus = balanceDue <= 0 ? 'paid' : 'partial'

        await invoiceService.updatePosInvoices(
            { id },
            { amount_paid: totalPaid, balance_due: balanceDue, status: newStatus }
        )

        const updated = await invoiceService.retrievePosInvoice(id)
        return res.json({ invoice: updated, payments: allPayments })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
