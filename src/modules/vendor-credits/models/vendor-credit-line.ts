import { model } from "@medusajs/utils";

/** Mirrors `vendor_credit_line` — see vendor-credit.ts for the DB-schema note. */
export const VendorCreditLine = model.define("vendor_credit_line", {
  id: model.id({ prefix: "vcrl" }).primaryKey(),
  credit_id: model.text(),
  sort: model.number().default(0),
  line_type: model.text(), // product | qb_account
  variant_id: model.text().nullable(),
  sku: model.text().nullable(),
  description: model.text().nullable(),
  qty: model.number().nullable(),
  unit_cost_cents: model.number().nullable(),
  qb_account_list_id: model.text().nullable(),
  qb_account_full_name: model.text().nullable(),
  qb_account_type: model.text().nullable(),
  amount_cents: model.number(),
});
