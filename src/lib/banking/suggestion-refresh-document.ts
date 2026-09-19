import type { Pool, PoolClient } from "pg";

import { refreshStatementSuggestions } from "./suggestion-runner";

type Queryable = Pick<Pool | PoolClient, "query">;
type Refresh = (
  statementId: string,
  actorId: string,
  trigger: "manual"
) => Promise<unknown>;

/**
 * A GL document that just changed shape (check revise / void, transfer void,
 * journal entry void) reverses or replaces Bank lines the feed may already be
 * SUGGESTING. The engine excludes canceled lines when it runs — but nothing
 * re-ran it, so the Bank Feed kept offering "CHK-0999 #1127" after the check
 * became #1120 (09/18/2026). Recompute every DRAFT statement whose window is
 * within 30 days of a Bank/CreditCard line of the document (the widest
 * suggestion tolerance). Runs AFTER the document's transaction committed and
 * never fails the caller: a refresh that breaks is reported, not thrown.
 */
export async function refreshSuggestionsForDocument(
  db: Queryable,
  sourceId: string,
  actorId: string,
  refresh: Refresh = refreshStatementSuggestions
): Promise<string[]> {
  const statements = (
    await db.query<{ id: string }>(
      `SELECT DISTINCT s.id FROM bank_journal_entry e
         JOIN bank_journal_line l ON l.entry_id=e.id AND l.deleted_at IS NULL
         JOIN bank_statement s ON s.account_list_id=l.account_list_id AND s.status='draft' AND s.deleted_at IS NULL
          AND e.day::date BETWEEN s.from_day::date - 30 AND s.to_day::date + 30
        WHERE e.source_id=$1 AND e.deleted_at IS NULL
          AND l.account_snapshot->>'account_type' IN ('Bank','CreditCard')`,
      [sourceId]
    )
  ).rows;
  const refreshed: string[] = [];
  for (const { id } of statements) {
    try {
      await refresh(id, actorId, "manual");
      refreshed.push(id);
    } catch (error) {
      console.warn(
        `[banking] suggestion refresh after document ${sourceId} failed for ${id}`,
        error
      );
    }
  }
  return refreshed;
}
