import { model } from "@medusajs/utils";
import { BankDeposit } from "./bank-deposit";

export const BankDepositLine = model.define("bank_deposit_line", {
  id: model.id({ prefix: "bdl" }).primaryKey(),
  deposit: model.belongsTo(() => BankDeposit, { mappedBy: "lines" }),
  payment_id: model.text().nullable(), opening_item_id: model.text().nullable(), amount: model.text(), source_hash: model.text(), payment_snapshot: model.json(),
});
