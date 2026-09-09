import { model } from "@medusajs/utils";
export const BankMerchantSettlement = model.define("bank_merchant_settlement", {
  id: model.id({ prefix: "bms" }).primaryKey(),
  revision: model.number(),
  processor: model.text(),
  merchant: model.text(),
  reference: model.text(),
  currency: model.text(),
  payload: model.json(),
  source_snapshot: model.json(),
  created_by: model.text(),
});
