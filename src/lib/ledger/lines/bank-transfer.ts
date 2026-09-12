import { LedgerAccount, LedgerError, LedgerLine } from "../types";

export interface BankTransferInput {
  fromAccount: LedgerAccount;
  toAccount: LedgerAccount;
  /** Lo que SALE de `fromAccount`. */
  amount_cents: bigint;
  /** Comisión que cobra el banco; `toAccount` recibe `amount − fee`. Default 0. */
  fee_cents?: bigint;
  /** Cuenta de gasto del fee; obligatoria si `fee_cents > 0`. */
  feeAccount?: LedgerAccount | null;
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

/** Tipos admitidos para la cuenta del fee: es un gasto, no otra cuenta de balance. */
export const TRANSFER_FEE_ACCOUNT_TYPES = ["Expense"] as const;

/**
 * Builder puro de `bank_transfer`: Dr `to_account` (amount − fee) /
 * Dr `fee_account` (fee, sólo si hay) / Cr `from_account` (amount).
 * Pagar una tarjeta desde el banco es esto mismo (Dr CreditCard baja el
 * pasivo, Cr Bank baja el activo).
 */
export function buildBankTransferLines(input: BankTransferInput): LedgerLine[] {
  const { fromAccount, toAccount, amount_cents } = input;
  const fee = input.fee_cents ?? 0n;
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
  if (fee < 0n)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "fee_negative",
      fee_cents: fee.toString(),
    });
  // El fee se descuenta de lo que llega: un fee ≥ amount no deja nada en `to`.
  if (fee >= amount_cents)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "fee_not_below_amount",
      fee_cents: fee.toString(),
      amount_cents: amount_cents.toString(),
    });
  const feeAccount = fee > 0n ? (input.feeAccount ?? null) : null;
  if (fee > 0n && !feeAccount)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "fee_account_required",
      fee_cents: fee.toString(),
    });
  if (
    feeAccount &&
    !(TRANSFER_FEE_ACCOUNT_TYPES as readonly string[]).includes(
      feeAccount.account_type
    )
  )
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "fee_account_type_not_expense",
      account_list_id: feeAccount.id,
      account_type: feeAccount.account_type,
    });

  const lines: LedgerLine[] = [
    {
      role: "to_account",
      account: toAccount,
      debit_cents: amount_cents - fee,
      credit_cents: 0n,
    },
  ];
  if (feeAccount)
    lines.push({
      role: "fee_account",
      account: feeAccount,
      debit_cents: fee,
      credit_cents: 0n,
    });
  lines.push({
    role: "from_account",
    account: fromAccount,
    debit_cents: 0n,
    credit_cents: amount_cents,
  });
  return lines;
}
