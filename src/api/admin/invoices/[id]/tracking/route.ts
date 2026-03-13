/**
 * src/api/admin/invoices/[id]/tracking/route.ts
 * POST /admin/invoices/:id/tracking — Add tracking info to an invoice
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { INVOICE_MODULE } from '../../../../../modules/invoices'

interface TrackingBody {
    carrier?: string
    tracking_number: string
    tracking_url?: string
    shipped_at?: string  // ISO date string
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const invoiceService = req.scope.resolve(INVOICE_MODULE)
    const id = req.params.id!
    const body = req.body as TrackingBody

    if (!body.tracking_number) {
        return res.status(400).json({ error: 'tracking_number is required' })
    }

    // Verify invoice exists
    try {
        await invoiceService.retrievePosInvoice(id)
    } catch {
        return res.status(404).json({ error: 'Invoice not found' })
    }

    const tracking = await invoiceService.createInvoiceTrackings({
        invoice_id:      id,
        carrier:         body.carrier ?? null,
        tracking_number: body.tracking_number,
        tracking_url:    body.tracking_url ?? null,
        shipped_at:      body.shipped_at ? new Date(body.shipped_at) : null,
    })

    return res.status(201).json({ tracking })
}
