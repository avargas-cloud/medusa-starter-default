import { model } from '@medusajs/framework/utils'
import { PaymentApplication } from './payment-application'

/**
 * CustomerPayment — unified payment ledger entry per customer.
 *
 * Every payment in the system (web checkout or POS) creates a record here
 * so we have a single source of truth for customer AR.
 *
 * source:
 *   - "web"  → created by subscriber on order.payment_captured
 *              locked to the order; medusa_payment_id references native payment
 *   - "pos"  → created manually by staff (cash, check, ACH, etc.)
 *              may be "available" (deposit) or immediately "applied" to an invoice
 *
 * type:
 *   - "payment"     → money received from customer
 *   - "refund"      → money returned to customer (card refund or store credit)
 *   - "credit_memo" → store credit issued manually
 *
 * status (only POS payments can be "available"):
 *   - available          → floating credit, can be applied to any invoice
 *   - partially_applied  → some amount applied, remainder still available
 *   - applied            → fully consumed (or web: immediately applied to its order)
 *   - voided             → cancelled before being used
 */
const CustomerPayment = model.define('customer_payment', {
    id:                  model.id({ prefix: 'cpay' }).primaryKey(),
    customer_id:         model.text(),                  // always required — no orphan payments
    source:              model.enum(['web', 'pos']).default('pos'),
    type:                model.enum(['payment', 'refund', 'credit_memo']).default('payment'),
    amount:              model.bigNumber(),              // in cents (USD)
    currency:            model.text().default('usd'),
    method:              model.enum(['cash', 'check', 'card', 'ach', 'zelle', 'credit_memo', 'stripe', 'authorize_net', 'other']).default('other'),
    reference:           model.text().nullable(),        // check #, last4, Stripe charge ID, etc.
    status:              model.enum(['available', 'partially_applied', 'applied', 'voided']).default('available'),
    // Web-only: reference to native Medusa payment (deduplication key + audit trail)
    medusa_payment_id:   model.text().nullable(),        // payment.id from Medusa payment module
    medusa_refund_id:    model.text().nullable(),        // payment_refund.id if this is a refund mirror
    // The order this payment is locked to (web: always set; POS: set when applied)
    locked_order_id:     model.text().nullable(),        // web payments are locked to their order
    received_at:         model.dateTime(),
    notes:               model.text().nullable(),
    created_by:          model.text().nullable(),        // admin user email / "system" for subscribers
    applications:        model.hasMany(() => PaymentApplication, { mappedBy: 'payment' }),
})

export { CustomerPayment }
