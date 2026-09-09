import { model } from "@medusajs/utils";

import { BankReviewRule } from "./bank-review-rule";
import { BankTransaction } from "./bank-transaction";

/** Current preparation decision; previous decisions survive in bank_review_event. */
export const BankTransactionReview = model.define("bank_transaction_review", {
  id: model.id({ prefix: "brvw" }).primaryKey(),
  transaction: model.belongsTo(() => BankTransaction, { mappedBy: "reviews" }),
  revision: model.number().default(1),
  source_version: model.number(),
  status: model.enum(["draft", "confirmed", "excluded"]).default("draft"),
  mode: model.enum(["categorize", "match", "deposit"]).default("categorize"),
  category_list_id: model.text().nullable(),
  counterparty_type: model.enum(["vendor", "customer"]).nullable(),
  counterparty_id: model.text().nullable(),
  counterparty_name: model.text().nullable(),
  comment: model.text().default(""),
  matched_payment_id: model.text().nullable(),
  match_snapshot: model.json().nullable(),
  matched_deposit_id: model.text().nullable(),
  deposit_snapshot: model.json().nullable(),
  category_snapshot: model.json().nullable(),
  origin: model.enum(["manual", "rule"]).default("manual"),
  rule: model
    .belongsTo(() => BankReviewRule, { mappedBy: "reviews" })
    .nullable(),
  rule_version: model.number().nullable(),
  manual_override: model.boolean().default(false),
  confirmed_by: model.text().nullable(),
  confirmed_at: model.dateTime().nullable(),
  exclusion_reason: model.text().nullable(),
});
