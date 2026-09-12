import { LedgerAccount, LedgerError, LedgerLine } from "../types";

export interface BankTransferInput {
  fromAccount: LedgerAccount;
  toAccount: LedgerAccount;
  amount_cents: bigint;
}

/** Cuentas entre las que se puede transferir (Balance Sheet, saldo propio). */
export const TRANSFER_ACCOUNT_TYPES = [
  "Bank",
  "CreditCard",
  "OtherCurrentAsset",
  "OtherCurrentLiability",
  "LongTermLiability",
  "Equity",
] as const;

/**
 * Builder puro de `bank_transfer`: Dr `to_account` / Cr `from_account`.
 * Pagar una tarjeta desde el banco es esto mismo (Dr CreditCard baja el
 * pasivo, Cr Bank baja el activo).
 */
export function buildBankTransferLines(input: BankTransferInput): LedgerLine[] {
  const { fromAccount, toAccount, amount_cents } = input;
  if (amount_cents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "amount_not_positive",
      amount_cents: amount_cents.toString(),
    });
  if (fromAccount.id === toAccount.id)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "same_account" });
  for (const account of [fromAccount, toAccount]) {
    if (
      !(TRANSFER_ACCOUNT_TYPES as readonly string[]).includes(
        account.account_type
      )
    )
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "account_type_not_transferable",
        account_list_id: account.id,
        account_type: account.account_type,
      });
  }
  return [
    {
      role: "to_account",
      account: toAccount,
      debit_cents: amount_cents,
      credit_cents: 0n,
    },
    {
      role: "from_account",
      account: fromAccount,
      debit_cents: 0n,
      credit_cents: amount_cents,
    },
  ];
}
