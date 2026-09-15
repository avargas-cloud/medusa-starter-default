/**
 * Month Close reopen, factored out of `api/admin/accounting/month-close/reopen*`
 * so the bank statement reopen chain can reopen a closed month inside its own
 * transaction (`lib/banking/statement-reopen-chain.ts`, 2026-09-15). Behaviour is
 * the route's, unchanged: the newest `closed` revision, a posted prior-period
 * adjustment blocks, and the operator's `input_hash` must match a fresh preview.
 *
 * Callers hold the period lock (`withBankAccountingMonthLock` from knex, or
 * `acquireBankAccountingPeriodLock` from a pg transaction) — this file never locks.
 */
import { createHash } from "node:crypto";

import {
  loadMonthSummary,
  loadOpenDocuments,
  normalizeMonthSummary,
  summaryDelta,
  type MonthRange,
  type MonthSummary,
  type OpenDocumentCounts,
  type SqlClient,
} from "./month-close-data";

export type ClosedMonthRow = {
  id: string;
  revision: number;
  period_start: string;
  closed_at: string;
  summary: Partial<MonthSummary>;
} & Record<string, unknown>;

export type MonthReopenPreviewBody = {
  close_id: string;
  revision: number;
  original: MonthSummary;
  current: MonthSummary;
  delta: MonthSummary;
  open_documents: OpenDocumentCounts;
};

export type MonthReopenPreview = {
  close: ClosedMonthRow;
  body: MonthReopenPreviewBody;
  input_hash: string;
};

export async function closedMonth(
  db: SqlClient,
  range: MonthRange
): Promise<ClosedMonthRow | null> {
  const rows = await db.raw(
    `SELECT * FROM accounting_period_close
      WHERE period_start = ?::date AND status = 'closed'
      ORDER BY revision DESC LIMIT 1`,
    [range.periodStart]
  );
  return (rows.rows[0] as ClosedMonthRow | undefined) ?? null;
}

/** The posted prior-period adjustment that must be reversed before this close reopens, if any. */
export async function postedAdjustmentOf(
  db: SqlClient,
  closeId: string
): Promise<{ id: string; target_period_start: string } | null> {
  const rows = await db.raw(
    `SELECT id, target_period_start
       FROM accounting_period_adjustment
      WHERE source_close_id = ? AND status = 'posted'
      LIMIT 1`,
    [closeId]
  );
  return (
    (rows.rows[0] as { id: string; target_period_start: string } | undefined) ??
    null
  );
}

export function previewHash(body: MonthReopenPreviewBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Null when the month is not closed. */
export async function monthReopenPreview(
  db: SqlClient,
  range: MonthRange
): Promise<MonthReopenPreview | null> {
  const close = await closedMonth(db, range);
  if (!close) return null;
  const [current, openDocuments] = await Promise.all([
    loadMonthSummary(db, range),
    loadOpenDocuments(db, range),
  ]);
  const original = normalizeMonthSummary(close.summary, current);
  const body: MonthReopenPreviewBody = {
    close_id: close.id,
    revision: close.revision,
    original,
    current,
    delta: summaryDelta(original, current),
    open_documents: openDocuments,
  };
  return { close, body, input_hash: previewHash(body) };
}

export type MonthReopenResult =
  | { status: 200; body: { close: Record<string, unknown> } }
  | {
      status: 409;
      body: {
        error: string;
        code:
          | "month_not_closed"
          | "posted_adjustment_must_be_reversed_first"
          | "reopen_preview_stale";
        adjustment?: { id: string; target_period_start: string };
      };
    };

export async function reopenClosedMonth(
  db: SqlClient,
  input: {
    range: MonthRange;
    actorId: string;
    reason: string;
    input_hash: string;
  }
): Promise<MonthReopenResult> {
  const close = await closedMonth(db, input.range);
  if (!close)
    return {
      status: 409,
      body: { error: "This month is not closed.", code: "month_not_closed" },
    };
  const adjustment = await postedAdjustmentOf(db, close.id);
  if (adjustment)
    return {
      status: 409,
      body: {
        error:
          "This month already has a posted prior-period adjustment. Reverse that adjustment before reopening.",
        code: "posted_adjustment_must_be_reversed_first",
        adjustment,
      },
    };
  const preview = await monthReopenPreview(db, input.range);
  if (!preview || preview.input_hash !== input.input_hash)
    return {
      status: 409,
      body: {
        error:
          "The accounting data changed after the preview. Generate a fresh preview.",
        code: "reopen_preview_stale",
      },
    };
  const updated = await db.raw(
    `UPDATE accounting_period_close
        SET status = 'reopened', reopened_by_user_id = ?, reopened_at = NOW(),
            reopen_reason = ?, reopen_preview = ?::jsonb, updated_at = NOW()
      WHERE id = ? AND status = 'closed'
      RETURNING *`,
    [
      input.actorId,
      input.reason,
      JSON.stringify({ ...preview.body, input_hash: preview.input_hash }),
      close.id,
    ]
  );
  return { status: 200, body: { close: updated.rows[0] ?? {} } };
}
