/**
 * src/modules/invoices/models/invoice-tracking.ts
 * Optional tracking information attached to a dispatched invoice.
 * Triggers shipment notification email when saved.
 */

import { model } from '@medusajs/framework/utils'
import PosInvoice from './pos-invoice'

const InvoiceTracking = model.define('invoice_tracking', {
    id:              model.id().primaryKey(),
    invoice:         model.belongsTo(() => PosInvoice, { mappedBy: 'tracking_links' }),
    carrier:         model.text().nullable(),
    tracking_number: model.text(),
    tracking_url:    model.text().nullable(),
    shipped_at:      model.dateTime().nullable(),
    email_sent_at:   model.dateTime().nullable(),
})

export default InvoiceTracking
