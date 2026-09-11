import { signedLine } from "../money";
import { LedgerAccount, LedgerLine, PurchaseAccountMap } from "../types";

export interface BillPaymentSnapshot {
  amountCents: bigint;
  /** `qb_bank_account` (Bank o CreditCard) — resuelto por el loader vía `qb_account`. */
  bankAccount: LedgerAccount;
}

/**
 * gl-purchases-v2 §2: pagar un bill baja lo que se debe (débito AP) y baja
 * el banco/tarjeta (crédito). `amountCents` puede ser 0 cuando el pago sólo
 * aplica un crédito (`SetCredit`, §3 "Pay Bills") — un cheque de $0 no
 * postea nada al GL, el efecto ya lo tiene el `vendor_credit` aplicado.
 */
export function buildBillPaymentLines(
  snapshot: BillPaymentSnapshot,
  map: PurchaseAccountMap
): LedgerLine[] {
  const lines: LedgerLine[] = [];
  const apLine = signedLine("accounts_payable", map.accounts_payable, snapshot.amountCents);
  if (apLine) lines.push(apLine);
  const bankLine = signedLine("bank_account", snapshot.bankAccount, -snapshot.amountCents);
  if (bankLine) lines.push(bankLine);
  return lines;
}
