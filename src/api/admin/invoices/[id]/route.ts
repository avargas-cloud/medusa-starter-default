/**
 * src/api/admin/invoices/[id]/route.ts
 * GET   /admin/invoices/:id — Get a single invoice with items + tracking + payments
 * PATCH /admin/invoices/:id — Update invoice total (auto-synced when order items/shipping/promotions change)
 *                           → balance_due is recalculated from existing payments automatically
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../../modules/invoices'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const id = req.params.id!

    let invoice: any
    try {
        invoice = await invoiceService.retrievePosInvoice(id, {
            relations: ['items', 'tracking_links'],
        })
    } catch {
        return res.status(404).json({ error: 'Invoice not found' })
    }

    // Also load payments
    const payments = await invoiceService.listInvoicePayments(
        { invoice_id: id },
        { order: { paid_at: 'ASC' } }
    ).catch(() => [])

    return res.json({ invoice, payments })
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const id = req.params.id!
    const { total } = req.body as { total: number }

    if (!total || total <= 0) {
        return res.status(400).json({ error: 'total must be a positive number (cents)' })
    }

    try {
        const invoice = await invoiceService.retrievePosInvoice(id)
        if (!invoice) return res.status(404).json({ error: 'Invoice not found' })
        if (invoice.status === 'voided') {
            return res.status(400).json({ error: 'Cannot update a voided invoice' })
        }

        // Recalculate balance from existing payments
        const payments = await invoiceService.listInvoicePayments({ invoice_id: id }).catch(() => [])
        const totalPaid = payments.reduce((sum: number, p: any) => sum + Number(p.amount), 0)
        const balanceDue = total - totalPaid
        const newStatus = balanceDue <= 0 ? 'paid' : (totalPaid > 0 ? 'partial' : invoice.status)

        await invoiceService.updatePosInvoices(
            id,
            { total, balance_due: balanceDue, amount_paid: totalPaid, status: newStatus }
        )

        const updated = await invoiceService.retrievePosInvoice(id)
        return res.json({ invoice: updated })
    } catch (err: any) {
        return res.status(500).json({ error: err.message })
    }
}
