import { model } from "@medusajs/utils";
export const BankOpeningItem = model.define("bank_opening_item", {
  id: model.id({ prefix: "boi" }).primaryKey(),
  opening_id: model.text(),
  kind: model.enum(["uf_receipt","deposit_in_transit","outstanding_check"]),
  original_day: model.text(),
  amount_cents: model.text(),
  external_key: model.text(),
  reference: model.text(),
  description: model.text(),
  payment_id: model.text().nullable(),
  evidence_id: model.text().nullable(),
  source_snapshot: model.json(),
  source_hash: model.text()
});
