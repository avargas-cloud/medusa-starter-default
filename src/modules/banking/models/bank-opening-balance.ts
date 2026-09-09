import { model } from "@medusajs/utils";
export const BankOpeningBalance = model.define("bank_opening_balance", {
  id: model.id({ prefix: "bob" }).primaryKey(),
  revision: model.number(),
  kind: model.enum(["bank","clearing"]),
  status: model.enum(["draft","adopted","revoked"]),
  setup_id: model.text(),
  cut_date: model.text(),
  bank_account_id: model.text().nullable(),
  account_list_id: model.text(),
  currency: model.text(),
  account_snapshot: model.json(),
  book_balance_cents: model.text().nullable(),
  statement_balance_cents: model.text().nullable(),
  statement_evidence_id: model.text().nullable(),
  books_evidence_id: model.text().nullable(),
  reference: model.text(),
  adopted_by: model.text().nullable(),
  adopted_at: model.dateTime().nullable(),
  revoked_by: model.text().nullable(),
  revoked_at: model.dateTime().nullable(),
  revoke_reason: model.text().nullable()
});
