import { model } from "@medusajs/utils";

/**
 * Mirrors the `vendor_credit` table (src/migrations/1783400000000-
 * VendorCreditsAndBillPayments.ts). The table is created by that raw
 * migration, not by this module's own migrations (it has none — same
 * pattern as `order_commission`/`order_outsourced_service`, which have no
 * Medusa module at all). This model exists only so the module's thin
 * service can offer generated list/retrieve helpers; every write with an
 * invariant to enforce goes through `src/lib/vendor-credits/**` over a raw
 * pg client instead.
 */
export const VendorCredit = model.define("vendor_credit", {
  id: model.id({ prefix: "vcr" }).primaryKey(),
  number: model.text().nullable(),
  vendor_id: model.text(),
  vendor_name_snapshot: model.text().nullable(),
  vendor_qb_list_id_snapshot: model.text().nullable(),
  // PO the returned goods came from + the regular bill that invoiced them
  // (Migration 1783700000000). Snapshotted references, no FK — same as
  // `vendor_bill.purchase_order_id`. PO is fixed at create; bill editable
  // while draft.
  purchase_order_id: model.text().nullable(),
  vendor_bill_id: model.text().nullable(),
  credit_date: model.dateTime(),
  reason: model.text().nullable(),
  memo: model.text().nullable(),
  status: model.text().default("draft"), // draft | posted | voided
  // Plain `number()`, not `bigNumber()`: bigNumber expects a companion
  // `raw_*` jsonb column that this table (created by raw SQL, not by a
  // module migration) does not have. Cents fit safely in a JS number.
  total_cents: model.number().default(0),
  applied_cents: model.number().default(0),
  qb_txn_id: model.text().nullable(),
  qb_edit_sequence: model.text().nullable(),
  qb_synced_at: model.dateTime().nullable(),
  // Stock movement idempotency marks — set once by the post/void routes
  // after the Inventory module adjusted the PO location (never by SQL).
  stock_applied_at: model.dateTime().nullable(),
  stock_reversed_at: model.dateTime().nullable(),
  posted_at: model.dateTime().nullable(),
  posted_by: model.text().nullable(),
  voided_at: model.dateTime().nullable(),
  voided_by: model.text().nullable(),
  voided_reason: model.text().nullable(),
});
