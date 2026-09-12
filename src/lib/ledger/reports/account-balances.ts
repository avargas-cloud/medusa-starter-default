import type { SqlClient } from "../../accounting/month-close-data";

import { activeEntryPredicate } from "./active-entries";

export interface AccountBalanceRow {
  list_id: string;
  name: string;
  full_name: string;
  account_type: string;
  account_number: string | null;
  parent_list_id: string | null;
  parent_full_name: string | null;
  normal_balance: string | null;
  is_active: boolean;
  /** Σdebit − Σcredit over the main window (raw, unsigned by normal side). */
  raw_cents: string;
  /** Same over the compare window; "0" when no compare window was asked. */
  compare_raw_cents: string;
}

export interface BalanceWindow {
  from: string | null;
  to: string;
}

/**
 * One query for every report: each non-deleted posting account of the chart
 * with its raw movement over `main` and (optionally) `compare`. `from: null`
 * means "since the beginning" (balance-sheet style). Reversed pairs are out
 * via `activeEntryPredicate`. Inactive accounts stay in — an account can be
 * deactivated after it moved, and the report must still add up.
 */
export async function loadAccountBalances(
  db: SqlClient,
  main: BalanceWindow,
  compare: BalanceWindow | null,
  extraLineFilter = ""
): Promise<AccountBalanceRow[]> {
  const bindings: unknown[] = [];
  const windowSql = (w: BalanceWindow): string => {
    const parts: string[] = [];
    if (w.from !== null) {
      parts.push("e.day >= ?");
      bindings.push(w.from);
    }
    parts.push("e.day <= ?");
    bindings.push(w.to);
    return parts.join(" AND ");
  };
  const mainSql = windowSql(main);
  const compareSql = compare ? windowSql(compare) : "FALSE";
  const result = await db.raw(
    `WITH movement AS (
       SELECT l.account_list_id,
              COALESCE(SUM(CASE WHEN ${mainSql} THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS raw_cents,
              COALESCE(SUM(CASE WHEN ${compareSql} THEN l.debit_cents - l.credit_cents ELSE 0 END), 0) AS compare_raw_cents
         FROM bank_journal_line l
         JOIN bank_journal_entry e ON e.id = l.entry_id
        WHERE l.deleted_at IS NULL AND ${activeEntryPredicate("e")} ${extraLineFilter}
        GROUP BY l.account_list_id
     )
     SELECT qa.qb_list_id AS list_id, qa.name, qa.full_name, qa.account_type,
            qa.account_number, qa.parent_list_id, qa.parent_full_name,
            qa.normal_balance, qa.is_active,
            COALESCE(m.raw_cents, 0)::text AS raw_cents,
            COALESCE(m.compare_raw_cents, 0)::text AS compare_raw_cents
       FROM qb_account qa
       LEFT JOIN movement m ON m.account_list_id = qa.qb_list_id
      WHERE qa.deleted_at IS NULL AND qa.account_type <> 'NonPosting'
      ORDER BY qa.account_number NULLS LAST, qa.full_name`,
    bindings
  );
  return result.rows as unknown as AccountBalanceRow[];
}
