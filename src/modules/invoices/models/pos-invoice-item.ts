/**
 * src/modules/invoices/models/pos-invoice-item.ts
 * Snapshot of the line items dispatched in a single invoice.
 * Stored at issue time so changes to the Order don't mutate existing invoices.
 */

import { model } from '@medusajs/framework/utils'
import PosInvoice from './pos-invoice'

const PosInvoiceItem = model.define('pos_invoice_item', {
    id:          model.id().primaryKey(),
    invoice:     model.belongsTo(() => PosInvoice, { mappedBy: 'items' }),
    variant_id:  model.text().nullable(),
    sku:         model.text().nullable(),
    description: model.text(),
    quantity:    model.number(),
    unit_price:  model.bigNumber(),
    total:       model.bigNumber(),
})

export default PosInvoiceItem
