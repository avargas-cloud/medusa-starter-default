import { model } from "@medusajs/utils";
export const BankStatementLine = model.define("bank_statement_line", {
  id: model.id({ prefix: "bsl" }).primaryKey(), statement_id: model.text(), external_key: model.text(), day: model.text(),
  amount_cents: model.text(), description: model.text(), transaction_id: model.text().nullable(),
  source_hash: model.text(), source_snapshot: model.json(),
});
