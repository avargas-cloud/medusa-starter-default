import { model } from "@medusajs/utils";

import { BankAccount } from "./bank-account";
import { BankTransactionReview } from "./bank-transaction-review";

export const BankReviewRule = model.define("bank_review_rule", {
  id: model.id({ prefix: "brule" }).primaryKey(),
  version: model.number().default(1),
  name: model.text(),
  account: model.belongsTo(() => BankAccount, { mappedBy: "review_rules" }),
  active: model.boolean().default(true),
  priority: model.number().default(100),
  match_field: model.enum(["merchant", "description"]),
  pattern: model.text(),
  direction: model.enum(["in", "out"]),
  currency: model.text(),
  category_list_id: model.text(),
  counterparty_type: model.enum(["vendor", "customer"]).nullable(),
  counterparty_id: model.text().nullable(),
  counterparty_name: model.text().nullable(),
  created_by: model.text(),
  updated_by: model.text(),
  reviews: model.hasMany(() => BankTransactionReview, { mappedBy: "rule" }),
});
