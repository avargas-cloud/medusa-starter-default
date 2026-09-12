import type { LedgerAccount, LedgerLine } from "../../lib/ledger/types";

export function account(
  id: string,
  account_type: string,
  normal_balance: "debit" | "credit" | null = null
): LedgerAccount {
  return { id, name: id, account_type, currency: "USD", normal_balance };
}

export const sumDebits = (lines: LedgerLine[]): bigint => lines.reduce((a, l) => a + l.debit_cents, 0n);
export const sumCredits = (lines: LedgerLine[]): bigint => lines.reduce((a, l) => a + l.credit_cents, 0n);
