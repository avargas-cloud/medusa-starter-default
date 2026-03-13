/**
 * src/api/admin/invoices/[id]/void/route.ts
 * POST /admin/invoices/:id/void — Void an issued invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../../../modules/invoices'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const id = req.params.id!
    const { void_reason } = req.body as { void_reason?: string }

    let invoice: any
    try {
        invoice = await invoiceService.retrievePosInvoice(id)
    } catch {
        return res.status(404).json({ error: 'Invoice not found' })
    }

    if (invoice.status === 'voided') {
        return res.status(409).json({ error: 'Invoice is already voided' })
    }

    const updated = await invoiceService.updatePosInvoices(
        { id },
        {
            status:     'voided' as const,
            voided_at:  new Date(),
            void_reason: void_reason ?? null,
        }
    )

    return res.json({ invoice: updated })
}
