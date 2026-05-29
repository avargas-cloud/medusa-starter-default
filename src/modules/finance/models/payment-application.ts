import { model } from "@medusajs/utils";

import { CustomerPayment } from "./customer-payment";

/**
 * PaymentApplication — links a CustomerPayment to a specific invoice (and its parent order).
 *
 * One CustomerPayment can have multiple applications (e.g. $10,000 split across 4 invoices).
 * Each application records exactly how much of a payment was applied to a specific invoice.
 *
 * invoice_id:
 *   - POS payments:  always set (the PosInvoice being paid)
 *   - Web payments:  NULL — web orders don't go through our PosInvoice flow
 *
 * order_id:
 *   - Always present — denormalized from invoice.order_id or from the order directly
 *   - Used for AR reporting without needing extra joins
 *
 * A voided application restores the amount_applied back to the CustomerPayment's available balance.
 */
const PaymentApplication = model.define("payment_application", {
  id: model.id({ prefix: "papp" }).primaryKey(),
  payment: model.belongsTo(() => CustomerPayment, { mappedBy: "applications" }),
  invoice_id: model.text().nullable(), // null for web orders (no PosInvoice)
  invoice_number: model.text().nullable(), // human-readable POS invoice number e.g. "30033" — written at apply time
  order_id: model.text(), // always set — the Medusa order
  amount_applied: model.bigNumber(), // in cents
  applied_at: model.dateTime(),
  applied_by: model.text().nullable(), // admin user email / "system" for subscribers
  voided_at: model.dateTime().nullable(),
  void_reason: model.text().nullable(),
  voided_by: model.text().nullable(),
  metadata: model.json().nullable(), // checkout-event audit (transaction_id, capture_context, credits_consumed, ...)
  /**
   * Frozen per-line cost basis captured when this application is attributed to
   * an order, so order-only COGS in Treasury does not drift when product
   * average cost changes later (e.g. receiving POs). NULL for legacy rows and
   * for invoice-bound rows (which use pos_invoice_item.average_unit_cost).
   * Shape: { captured_at: string, lines: Array<{ line_id, variant_id, sku,
   *          quantity, unit_cost_cents, is_china }> }. See buildOrderCostSnapshot.
   */
  cost_snapshot: model.json().nullable(),
});

export { PaymentApplication };
