import { sanitizeRole } from "../money";
import { LedgerAccount, LedgerError, LedgerLine } from "../types";

/** Cuentas de resultado que el cierre lleva a Retained Earnings. */
export const YEAR_CLOSE_ACCOUNT_TYPES = [
  "Income",
  "CostOfGoodsSold",
  "Expense",
  "OtherIncome",
  "OtherExpense",
] as const;

export interface YearCloseBalance {
  account: LedgerAccount;
  /** Σdebit − Σcredit del año en el journal (net de cierres previos). */
  balance_cents: bigint;
}

export interface YearCloseComputation {
  lines: LedgerLine[];
  /** Por cuenta con saldo ≠ 0: el importe que el cierre mueve (signo = Dr−Cr). */
  per_account: Array<{ account: LedgerAccount; balance_cents: bigint }>;
  /** Σcréditos − Σdébitos de las cuentas de resultado = utilidad del ejercicio. */
  net_income_cents: bigint;
}

/**
 * Builder puro de `year_close`: cada cuenta de resultado con saldo se lleva a
 * cero con la línea opuesta (`close_<list_id>`), y Retained Earnings recibe
 * la contrapartida neta en UNA línea (`retained_earnings`): utilidad → Cr
 * RE, pérdida → Dr RE. Cuentas con saldo 0 no generan línea. Si nada tiene
 * saldo el cierre no tiene qué mover → `GL_SOURCE_INVALID nothing_to_close`.
 */
export function computeYearClose(
  balances: YearCloseBalance[],
  retainedEarnings: LedgerAccount
): YearCloseComputation {
  if (retainedEarnings.account_type !== "Equity")
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "retained_earnings_not_equity",
      account_type: retainedEarnings.account_type,
    });
  const perAccount = balances.filter((b) => b.balance_cents !== 0n);
  if (perAccount.length === 0)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "nothing_to_close" });

  const lines: LedgerLine[] = [];
  let net = 0n;
  for (const { account, balance_cents } of perAccount) {
    if (
      !(YEAR_CLOSE_ACCOUNT_TYPES as readonly string[]).includes(
        account.account_type
      )
    )
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "account_type_not_closable",
        account_list_id: account.id,
        account_type: account.account_type,
      });
    if (account.id === retainedEarnings.id)
      throw new LedgerError("GL_SOURCE_INVALID", {
        reason: "retained_earnings_in_balances",
      });
    lines.push(
      balance_cents > 0n
        ? {
            role: sanitizeRole("close", account.id),
            account,
            debit_cents: 0n,
            credit_cents: balance_cents,
          }
        : {
            role: sanitizeRole("close", account.id),
            account,
            debit_cents: -balance_cents,
            credit_cents: 0n,
          }
    );
    net -= balance_cents;
  }

  // net > 0 = las cuentas de resultado tenían saldo acreedor neto (utilidad).
  if (net !== 0n) {
    lines.push(
      net > 0n
        ? {
            role: "retained_earnings",
            account: retainedEarnings,
            debit_cents: 0n,
            credit_cents: net,
          }
        : {
            role: "retained_earnings",
            account: retainedEarnings,
            debit_cents: -net,
            credit_cents: 0n,
          }
    );
  }
  if (lines.length > 200)
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "too_many_accounts",
      count: lines.length,
    });

  return {
    lines,
    per_account: perAccount.map((b) => ({
      account: b.account,
      balance_cents: b.balance_cents,
    })),
    net_income_cents: net,
  };
}
