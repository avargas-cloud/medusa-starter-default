import { model } from "@medusajs/utils";
export const BankReceiptAccounting = model.define("bank_receipt_accounting", {
  id: model.id({ prefix: "bra" }).primaryKey(),
  payment_id: model.text(),
  setup_id: model.text(),
});
