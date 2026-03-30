/**
 * src/modules/invoices/models/pos-invoice-item.ts
 * Snapshot of the line items dispatched in a single invoice.
 * Stored at issue time so changes to the Order don't mutate existing invoices.
 */

import { model } from "@medusajs/utils"
import PosInvoice from './pos-invoice'

const PosInvoiceItem = model.define('pos_invoice_item', {
    id:          model.id().primaryKey(),
    invoice:     model.belongsTo(() => PosInvoice, { mappedBy: 'items' }),
    variant_id:  model.text().nullable(),
    sku:         model.text().nullable(),
    description: model.text(),
    quantity:           model.number(),
    refunded_quantity:  model.number().default(0), // cumulative units refunded via credit memos
    unit_price:         model.bigNumber(),
    total:              model.bigNumber(),
})

export default PosInvoiceItem
