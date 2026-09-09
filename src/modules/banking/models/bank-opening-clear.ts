import { model } from "@medusajs/utils";
export const BankOpeningClear = model.define("bank_opening_clear", {
  id: model.id({ prefix: "boc" }).primaryKey(),
  item_id: model.text(),
  transaction_id: model.text(),
  kind: model.enum(["clear", "unclear"]),
  reverses_clear_id: model.text().nullable(),
  source_version: model.number(),
  item_hash: model.text(),
  source_snapshot: model.json(),
  review_snapshot: model.json().nullable(),
  actor_id: model.text(),
  reason: model.text().nullable(),
});
