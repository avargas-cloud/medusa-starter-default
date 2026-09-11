import { model } from "@medusajs/utils";

/** Mirrors `vendor_credit_application` — see vendor-credit.ts for the DB-schema note. */
export const VendorCreditApplication = model.define("vendor_credit_application", {
  id: model.id({ prefix: "vcap" }).primaryKey(),
  credit_id: model.text(),
  vendor_bill_id: model.text(),
  amount_cents: model.number(),
  applied_at: model.dateTime(),
  applied_by: model.text().nullable(),
  voided_at: model.dateTime().nullable(),
  voided_by: model.text().nullable(),
});
