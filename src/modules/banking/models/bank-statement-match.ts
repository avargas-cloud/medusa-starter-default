import { model } from "@medusajs/utils";
export const BankStatementMatch = model.define("bank_statement_match", {
  id: model.id({ prefix: "bsm" }).primaryKey(),
  statement_id: model.text(),
  statement_line_id: model.text(),
  book_kind: model.text(),
  book_id: model.text(),
  amount_cents: model.text(),
  book_hash: model.text(),
  line_hash: model.text(),
  actor_id: model.text(),
  removed_by: model.text().nullable(),
  removed_reason: model.text().nullable(),
});
