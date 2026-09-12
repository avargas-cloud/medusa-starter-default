import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

import { loadYearCloseAccountMap } from "../accounts";
import {
  YEAR_CLOSE_ACCOUNT_TYPES,
  YearCloseBalance,
  computeYearClose,
} from "../lines/year-close";
import {
  activeDocumentEntry,
  postDocumentJournal,
  reverseDocumentJournal,
} from "../post";
import {
  LedgerAccount,
  LedgerError,
  PostResult,
  ReverseResult,
} from "../types";

import {
  AccountSnapshot,
  reversalDay,
  toAccountSnapshot,
} from "./manual-shared";

/**
 * Cierre de ejercicio (`year_close`, `source_id` = año): al `YYYY-12-31`
 * lleva el saldo del año de cada cuenta de resultado a Retained Earnings.
 * No tiene tabla propia — el asiento del journal ES el documento; el estado
 * se lee de `activeDocumentEntry`.
 */

export const YEAR_RE = /^\d{4}$/;

export interface YearCloseAccountPreview {
  account: AccountSnapshot;
  /** Σdebit − Σcredit del año (signo contable, antes del cierre). */
  balance_cents: number;
}

export interface YearClosePreview {
  year: string;
  day: string;
  status: "posted" | "not_posted";
  entry_id: string | null;
  retained_earnings: AccountSnapshot | null;
  accounts: YearCloseAccountPreview[];
  /** Σcréditos − Σdébitos de las cuentas de resultado = utilidad (negativo = pérdida). */
  net_income_cents: number;
  /** Σ de cuentas Income/OtherIncome (saldo acreedor positivo). */
  income_cents: number;
  /** Σ de cuentas COGS/Expense/OtherExpense (saldo deudor positivo). */
  expense_cents: number;
}

function assertYear(year: string): void {
  if (!YEAR_RE.test(year))
    throw new LedgerError("GL_SOURCE_INVALID", {
      reason: "invalid_year",
      year,
    });
}

export const yearCloseDay = (year: string): string => `${year}-12-31`;

/**
 * Saldo del año por cuenta de resultado, leído del journal con la MISMA
 * definición de "entrada activa" que los reportes (`reports/active-entries.ts`:
 * ni reversada ni reversa — las dos mitades del par se van, así un void
 * fechado en otro año no deja media pata en cada ejercicio), EXCLUYENDO
 * además los asientos `year_close` (así el preview muestra lo que el cierre
 * mueve, esté o no ya posteado — "net de cierres previos").
 */
export async function loadYearBalances(
  client: PoolClient,
  year: string
): Promise<YearCloseBalance[]> {
  assertYear(year);
  const { rows } = await client.query<{
    qb_list_id: string;
    full_name: string;
    account_type: string;
    normal_balance: string | null;
    balance_cents: string;
  }>(
    `SELECT a.qb_list_id, a.full_name, a.account_type, a.normal_balance,
            (COALESCE(SUM(l.debit_cents), 0) - COALESCE(SUM(l.credit_cents), 0))::text AS balance_cents
     FROM bank_journal_line l
     JOIN bank_journal_entry e ON e.id = l.entry_id
     JOIN qb_account a ON a.qb_list_id = l.account_list_id
     WHERE l.deleted_at IS NULL
       AND e.deleted_at IS NULL AND e.reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
       AND e.day >= $1 AND e.day <= $2
       AND e.source_kind IS DISTINCT FROM 'year_close'
       AND a.account_type = ANY($3::text[])
     GROUP BY a.qb_list_id, a.full_name, a.account_type, a.normal_balance
     HAVING COALESCE(SUM(l.debit_cents), 0) <> COALESCE(SUM(l.credit_cents), 0)
     ORDER BY a.account_type, a.full_name`,
    [`${year}-01-01`, yearCloseDay(year), YEAR_CLOSE_ACCOUNT_TYPES]
  );
  return rows.map((r) => ({
    account: {
      id: r.qb_list_id,
      name: r.full_name,
      account_type: r.account_type,
      currency: "USD",
      normal_balance:
        r.normal_balance === "debit" || r.normal_balance === "credit"
          ? r.normal_balance
          : null,
    } satisfies LedgerAccount,
    balance_cents: BigInt(r.balance_cents),
  }));
}

async function retainedEarningsOrNull(
  client: PoolClient
): Promise<LedgerAccount | null> {
  try {
    return (await loadYearCloseAccountMap(client)).retained_earnings;
  } catch (error) {
    if (error instanceof LedgerError && error.code === "GL_ACCOUNT_MAP_MISSING")
      return null;
    throw error;
  }
}

export async function previewYearClose(
  client: PoolClient,
  year: string
): Promise<YearClosePreview> {
  assertYear(year);
  const balances = await loadYearBalances(client, year);
  const retainedEarnings = await retainedEarningsOrNull(client);
  const active = await activeDocumentEntry(client, "year_close", year);

  let income = 0n;
  let expense = 0n;
  for (const b of balances) {
    if (
      b.account.account_type === "Income" ||
      b.account.account_type === "OtherIncome"
    )
      income -= b.balance_cents;
    else expense += b.balance_cents;
  }
  return {
    year,
    day: yearCloseDay(year),
    status: active ? "posted" : "not_posted",
    entry_id: active?.id ?? null,
    retained_earnings: retainedEarnings
      ? toAccountSnapshot(retainedEarnings)
      : null,
    accounts: balances.map((b) => ({
      account: toAccountSnapshot(b.account),
      balance_cents: Number(b.balance_cents),
    })),
    net_income_cents: Number(income - expense),
    income_cents: Number(income),
    expense_cents: Number(expense),
  };
}

export async function postYearClose(
  client: PoolClient,
  year: string,
  actorId: string
): Promise<PostResult> {
  assertYear(year);
  const existing = await activeDocumentEntry(client, "year_close", year);
  if (existing) return { status: "already_posted", entry_id: existing.id };

  const map = await loadYearCloseAccountMap(client);
  const balances = await loadYearBalances(client, year);
  const computed = computeYearClose(balances, map.retained_earnings);

  const sourceSnapshot = {
    year,
    retained_earnings: toAccountSnapshot(map.retained_earnings),
    accounts: computed.per_account.map((p) => ({
      account: toAccountSnapshot(p.account),
      balance_cents: p.balance_cents.toString(),
    })),
    net_income_cents: computed.net_income_cents.toString(),
  };
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(sourceSnapshot))
    .digest("hex");

  return postDocumentJournal(client, {
    source_kind: "year_close",
    source_id: year,
    document_number: `YC-${year}`,
    day: yearCloseDay(year),
    reference: `YC-${year}`,
    description: `Year-end close ${year}`,
    lines: computed.lines,
    source_snapshot: sourceSnapshot,
    source_hash: sourceHash,
    actor_id: actorId,
  });
}

export async function reverseYearClose(
  client: PoolClient,
  year: string,
  reason: string,
  actorId: string
): Promise<ReverseResult> {
  assertYear(year);
  return reverseDocumentJournal(client, {
    source_kind: "year_close",
    source_id: year,
    day: reversalDay(yearCloseDay(year)),
    reason,
    actor_id: actorId,
  });
}
