import { model } from "@medusajs/utils";
export const BankAccountingSetup = model.define("bank_accounting_setup", {
  id: model.id({ prefix: "bas" }).primaryKey(),
  revision: model.number(), cut_date: model.text(), currency: model.text(), ar_account_list_id: model.text(), clearing_account_list_id: model.text(), ar_account_snapshot: model.json(), clearing_account_snapshot: model.json(), attested: model.boolean(), actor_id: model.text(),
});
