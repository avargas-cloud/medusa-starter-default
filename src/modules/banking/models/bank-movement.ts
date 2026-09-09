import { model } from "@medusajs/utils";
export const BankMovement = model.define("bank_movement", {
  id: model.id({ prefix: "bmv" }).primaryKey(),
  revision: model.number(),
  kind: model.text(),
  reference: model.text(),
  payload: model.json(),
  source_snapshot: model.json(),
  created_by: model.text(),
});
