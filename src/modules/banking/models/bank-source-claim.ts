import { model } from "@medusajs/utils";
export const BankSourceClaim = model.define("bank_source_claim", {
  id: model.id({ prefix: "bsc" }).primaryKey(),
  entry_id: model.text(),
  source_kind: model.text(),
  source_id: model.text(),
  amount_cents: model.text(),
  capacity_cents: model.text(),
  source_hash: model.text(),
  source_snapshot: model.json(),
});
