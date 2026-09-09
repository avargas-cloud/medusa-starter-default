import { model } from "@medusajs/utils";

import { BankConnection } from "./bank-connection";
import { BankReviewRule } from "./bank-review-rule";
import { BankTransaction } from "./bank-transaction";

/** A provider account. QB mapping is a reference only, with no finance-module link. */
export const BankAccount = model.define("bank_account", {
  id: model.id({ prefix: "bacct" }).primaryKey(),
  connection: model.belongsTo(() => BankConnection, { mappedBy: "accounts" }),
  provider_account_id: model.text(),
  persistent_account_id: model.text().nullable(),
  name: model.text(),
  official_name: model.text().nullable(),
  mask: model.text().nullable(),
  type: model.text(),
  subtype: model.text().nullable(),
  currency: model.text().nullable(),
  qb_list_id: model.text().nullable(),
  is_active: model.boolean().default(true),
  is_selected: model.boolean().default(false),
  // Monetary values inside this snapshot must also remain exact decimal strings.
  balances: model.json().nullable(),
  balance_updated_at: model.dateTime().nullable(),
  source_data: model.json().nullable(),
  review_start_date: model.text().nullable(),
  opening_bank_balance: model.text().nullable(),
  opening_balance_date: model.text().nullable(),
  opening_reference: model.text().nullable(),
  opening_book_balance: model.text().nullable(),
  setup_revision: model.number().default(0),
  review_rules: model.hasMany(() => BankReviewRule, { mappedBy: "account" }),
  transactions: model.hasMany(() => BankTransaction, { mappedBy: "account" }),
});
