import { model } from "@medusajs/utils";
export const BankDirectExpense = model.define("bank_direct_expense", {
  id: model.id({ prefix: "bexp" }).primaryKey(), transaction_id: model.text(),
  revision: model.number(), nature: model.enum(["new_direct_expense"]),
  reference: model.text(), description: model.text(), attested: model.boolean(),
  dismissals: model.json(), source_hash: model.text(), created_by: model.text(), updated_by: model.text(),
});
