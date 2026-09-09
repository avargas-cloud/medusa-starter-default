import { model } from "@medusajs/utils";
export const BankJournalLine = model.define("bank_journal_line", {
  id: model.id({ prefix: "bjl" }).primaryKey(), entry_id: model.text(), role: model.text(),
  account_list_id: model.text(), account_snapshot: model.json(), debit_cents: model.text(), credit_cents: model.text(),
});
