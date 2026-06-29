import { model } from "@medusajs/utils";

/**
 * Immutable audit row for a "transfer payment to another customer" action.
 * One row per transfer. Keeps the old/new customer + QB txn lineage so the
 * reassignment is queryable for accounting reconciliation (the QB ReceivePayment
 * is deleted under the old customer and recreated under the new one).
 */
const CustomerPaymentTransfer = model.define("customer_payment_transfer", {
  id: model.id({ prefix: "cptr" }).primaryKey(),
  payment_id: model.text(),
  from_customer_id: model.text(),
  to_customer_id: model.text(),
  amount: model.bigNumber(), // cents
  reason: model.text().nullable(),
  requested_by: model.text(), // authenticated staff user id (not trusted from body)
  // QB lineage — filled in asynchronously by the transfer_payment pipeline step
  qb_old_txn_id: model.text().nullable(),
  qb_new_txn_id: model.text().nullable(),
  qb_status: model.text().default("pending"), // 'pending' | 'not_synced' | 'completed' | 'failed'
});

export { CustomerPaymentTransfer };
