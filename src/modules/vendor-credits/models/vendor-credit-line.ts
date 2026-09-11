import { model } from "@medusajs/utils";

/** Mirrors `vendor_credit_line` — see vendor-credit.ts for the DB-schema note. */
export const VendorCreditLine = model.define("vendor_credit_line", {
  id: model.id({ prefix: "vcrl" }).primaryKey(),
  credit_id: model.text(),
  sort: model.number().default(0),
  line_type: model.text(), // product | qb_account
  variant_id: model.text().nullable(),
  // The PO line this product line returns (Migration 1783700000000). Required
  // on every product line of a PO-linked credit; the "returned ≤ received"
  // cap is enforced per PO line across all active credits (po-link.ts).
  purchase_order_line_id: model.text().nullable(),
  sku: model.text().nullable(),
  // Mirrors vendor_bill_line.mpn — defaults from product_variant.metadata->>'mpn'
  // at insert time when a product line doesn't send one (create.ts/update.ts).
  mpn: model.text().nullable(),
  description: model.text().nullable(),
  qty: model.number().nullable(),
  unit_cost_cents: model.number().nullable(),
  qb_account_list_id: model.text().nullable(),
  qb_account_full_name: model.text().nullable(),
  qb_account_type: model.text().nullable(),
  amount_cents: model.number(),
  // QuickBooks TxnLineID of this line, written back from the VendorCreditRet
  // on Add/Mod confirmation (Migration 1783800000000). A VendorCreditMod
  // addresses existing lines by it; NULL = re-sent as a new line (-1).
  qb_txn_line_id: model.text().nullable(),
});
