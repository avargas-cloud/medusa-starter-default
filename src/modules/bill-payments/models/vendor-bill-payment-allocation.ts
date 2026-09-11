import { model } from "@medusajs/utils";

/** Mirrors `vendor_bill_payment_allocation` — see vendor-bill-payment.ts for the DB-schema note. */
export const VendorBillPaymentAllocation = model.define(
  "vendor_bill_payment_allocation",
  {
    id: model.id({ prefix: "vbpa" }).primaryKey(),
    payment_id: model.text(),
    vendor_bill_id: model.text(),
    amount_cents: model.number(),
    credit_application_id: model.text().nullable(),
  }
);
