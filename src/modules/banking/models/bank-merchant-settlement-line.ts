import { model } from "@medusajs/utils";
export const BankMerchantSettlementLine = model.define(
  "bank_merchant_settlement_line",
  {
    id: model.id({ prefix: "bml" }).primaryKey(),
    settlement_id: model.text(),
    sort_order: model.number(),
    kind: model.text(),
    source_id: model.text(),
    amount_cents: model.text(),
    payload: model.json(),
  }
);
