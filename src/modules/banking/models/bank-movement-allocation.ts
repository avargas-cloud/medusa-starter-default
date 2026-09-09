import { model } from "@medusajs/utils";
export const BankMovementAllocation = model.define("bank_movement_allocation", {
  id: model.id({ prefix: "bma" }).primaryKey(),
  movement_id: model.text(),
  sort_order: model.number(),
  source_kind: model.text(),
  source_id: model.text(),
  amount_cents: model.text(),
  capacity_cents: model.text().nullable(),
  payload: model.json(),
});
