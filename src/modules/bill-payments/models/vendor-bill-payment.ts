import { model } from "@medusajs/utils";

/**
 * Mirrors `vendor_bill_payment` (src/migrations/1783400000000-
 * VendorCreditsAndBillPayments.ts). Same DB-schema note as
 * vendor-credits/models/vendor-credit.ts: table created by raw SQL, plain
 * `number()` for cents (no `raw_*` companion column exists).
 */
export const VendorBillPayment = model.define("vendor_bill_payment", {
  id: model.id({ prefix: "vbp" }).primaryKey(),
  number: model.text().nullable(),
  vendor_id: model.text(),
  vendor_name_snapshot: model.text().nullable(),
  vendor_qb_list_id_snapshot: model.text().nullable(),
  bank_account_list_id: model.text(),
  bank_account_snapshot: model.json().nullable(),
  payment_date: model.dateTime(),
  method: model.text(), // check | ach | wire | card | cash
  reference: model.text().nullable(),
  amount_cents: model.number(),
  memo: model.text().nullable(),
  status: model.text().default("posted"), // posted | voided
  qb_txn_id: model.text().nullable(),
  qb_edit_sequence: model.text().nullable(),
  qb_synced_at: model.dateTime().nullable(),
  posted_at: model.dateTime(),
  posted_by: model.text().nullable(),
  voided_at: model.dateTime().nullable(),
  voided_by: model.text().nullable(),
  voided_reason: model.text().nullable(),
});
