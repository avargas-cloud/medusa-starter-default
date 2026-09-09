import { model } from "@medusajs/utils";
export const BankReceiptConsumption = model.define("bank_receipt_consumption", {
  id: model.id({ prefix: "brc" }).primaryKey(),
  entry_id: model.text(),
  receipt_id: model.text().nullable(),
  payment_id: model.text().nullable(),
  opening_item_id: model.text().nullable(),
  amount_cents: model.text(),
  origin_kind: model.enum(["deposit", "payment_match"]),
  origin_id: model.text(),
});
