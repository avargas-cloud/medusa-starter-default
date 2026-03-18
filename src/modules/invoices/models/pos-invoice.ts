/**
 * src/modules/invoices/models/pos-invoice.ts
 * Core invoice entity.
 * One Medusa Order → multiple Fulfillments → one PosInvoice per dispatch.
 * Status lifecycle: draft → issued → paid → voided
 */

import { model } from '@medusajs/framework/utils'
import PosInvoiceItem from './pos-invoice-item'
import InvoiceTracking from './invoice-tracking'

const PosInvoice = model.define('pos_invoice', {
    id:             model.id().primaryKey(),
    invoice_number: model.text(),            // INV-{order.display_id}-{seq}
    order_id:       model.text(),            // FK → Medusa Order (external)
    fulfillment_id: model.text().nullable(), // FK → Medusa Fulfillment (external)
    customer_id:    model.text(),            // FK → Medusa Customer (external)
    status:         model.enum(['draft', 'issued', 'partial', 'paid', 'voided']).default('issued'),
    subtotal:       model.bigNumber(),       // in cents
    discount:       model.bigNumber().default(0),  // in cents
    shipping:       model.number().default(0),     // in cents (plain numeric in DB)
    tax:            model.bigNumber(),
    total:          model.bigNumber(),
    amount_paid:    model.bigNumber(),
    balance_due:    model.bigNumber(),
    payment_method: model.enum(['cash', 'check', 'card', 'ach', 'credit', 'mixed']),
    issued_at:      model.dateTime().nullable(),
    paid_at:        model.dateTime().nullable(),
    voided_at:      model.dateTime().nullable(),
    void_reason:    model.text().nullable(),
    notes:          model.text().nullable(),
    created_by:     model.text().nullable(), // admin user email/id
    shipping_address: model.json().nullable(), // snapshot of order.shipping_address at creation time
    items:          model.hasMany(() => PosInvoiceItem, { mappedBy: 'invoice' }),
    tracking_links: model.hasMany(() => InvoiceTracking, { mappedBy: 'invoice' }),
})

export default PosInvoice
