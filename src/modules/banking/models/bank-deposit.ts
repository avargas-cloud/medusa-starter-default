import { model } from "@medusajs/utils";

import { BankDepositLine } from "./bank-deposit-line";

export const BankDeposit = model.define("bank_deposit", {
  id: model.id({ prefix: "bdep" }).primaryKey(),
  account_id: model.text(),
  revision: model.number().default(1),
  status: model.enum(["draft", "ready", "void"]).default("draft"),
  currency: model.text(),
  deposit_date: model.text(),
  reference: model.text(),
  memo: model.text().default(""),
  gross_amount: model.text(),
  fee_amount: model.text().default("0.00"),
  fee_account_list_id: model.text().nullable(),
  fee_reference: model.text().nullable(),
  fee_account_snapshot: model.json().nullable(),
  net_amount: model.text(),
  created_by: model.text(),
  ready_by: model.text().nullable(),
  ready_at: model.dateTime().nullable(),
  voided_by: model.text().nullable(),
  voided_at: model.dateTime().nullable(),
  void_reason: model.text().nullable(),
  lines: model.hasMany(() => BankDepositLine, { mappedBy: "deposit" }),
});
