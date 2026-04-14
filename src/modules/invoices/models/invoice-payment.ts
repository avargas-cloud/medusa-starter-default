import { model } from "@medusajs/utils";

export const InvoicePayment = model.define("invoice_payment", {
  id: model.id({ prefix: "ipay" }).primaryKey(),
  invoice_id: model.text(),
  amount: model.bigNumber(), // cents
  payment_method: model.text(), // cash | check | card | ach | credit | mixed
  paid_at: model.dateTime().default(new Date()),
  notes: model.text().nullable(),
  created_by: model.text().nullable(),
});
