import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  buildReadiness,
  loadMonthSummary,
  loadOpenDocuments,
  normalizeMonthSummary,
  parseMonth,
  summaryDelta,
  type MonthSummary,
  type SqlClient,
} from "../../../../lib/accounting/month-close-data";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../lib/accounting/month-close-auth";
import { captureInventoryValuationSnapshot } from "../../../../lib/cost/inventory-snapshot";

function dbFrom(req: AuthenticatedMedusaRequest): SqlClient {
  return req.scope.resolve("__pg_connection__") as SqlClient;
}

function authError(res: MedusaResponse, error: unknown) {
  if (error instanceof FullAdminRequiredError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const range = parseMonth(req.query.month);
  if (!range) {
    return res.status(400).json({
      error: "month is required in YYYY-MM format",
      code: "invalid_month",
    });
  }

  const db = dbFrom(req);
  const [summary, openDocuments, closeRows, historyRows, adjustmentRows] = await Promise.all([
    loadMonthSummary(db, range),
    loadOpenDocuments(db, range),
    db.raw(
      `SELECT * FROM accounting_period_close
        WHERE period_start = ?::date AND status = 'closed'
        ORDER BY revision DESC LIMIT 1`,
      [range.periodStart]
    ),
    db.raw(
      `SELECT id, revision, status, closed_at, reopened_at, close_note, reopen_reason
         FROM accounting_period_close
        WHERE period_start = ?::date
        ORDER BY revision DESC`,
      [range.periodStart]
    ),
    db.raw(
      `SELECT a.*
         FROM accounting_period_adjustment a
         JOIN accounting_period_close c ON c.id = a.source_close_id
        WHERE c.period_start = ?::date AND a.status = 'posted'
        ORDER BY a.posted_at DESC`,
      [range.periodStart]
    ),
  ]);

  const activeClose = closeRows.rows[0] ?? null;
  const original = activeClose
    ? normalizeMonthSummary(activeClose.summary as Partial<MonthSummary>, summary)
    : undefined;
  return res.json({
    month: range.month,
    range,
    status: activeClose ? "closed" : "open",
    active_close: activeClose ? { ...activeClose, summary: original } : null,
    current_restated: summary,
    delta: original ? summaryDelta(original, summary) : null,
    open_documents: openDocuments,
    readiness: buildReadiness(openDocuments),
    history: historyRows.rows,
    active_adjustment: adjustmentRows.rows[0] ?? null,
  });
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    return authError(res, error);
  }

  const body = req.body as {
    month?: string;
    acknowledge_warnings?: boolean;
    note?: string;
  };
  const range = parseMonth(body.month);
  if (!range) {
    return res.status(400).json({
      error: "month is required in YYYY-MM format",
      code: "invalid_month",
    });
  }
  if (new Date(range.to).getTime() > Date.now()) {
    return res.status(409).json({
      error: "The month cannot be closed before it has ended.",
      code: "month_not_ended",
    });
  }

  const db = dbFrom(req);
  const [summary, openDocuments] = await Promise.all([
    loadMonthSummary(db, range),
    loadOpenDocuments(db, range),
  ]);
  const readiness = buildReadiness(openDocuments);
  if (readiness.has_blockers) {
    return res.status(409).json({
      error: "Resolve blocking accounting documents before closing this month.",
      code: "month_close_blocked",
      readiness,
      open_documents: openDocuments,
    });
  }
  if (readiness.has_warnings && !body.acknowledge_warnings) {
    return res.status(409).json({
      error: "Open documents require administrator acknowledgement.",
      code: "month_close_warning_ack_required",
      readiness,
      open_documents: openDocuments,
    });
  }
  const existingClose = await db.raw(
    `SELECT id FROM accounting_period_close
      WHERE period_start = ?::date AND status = 'closed' LIMIT 1`,
    [range.periodStart]
  );
  if (existingClose.rows[0]) {
    return res.status(409).json({
      error: "This month is already closed.",
      code: "month_already_closed",
    });
  }

  const id = `apc_${range.month.replace("-", "")}_${Date.now().toString(36)}`;
  try {
    const asOf = new Date(new Date(range.to).getTime() - 1).toISOString();
    const inventorySnapshots = [];
    for (const warehouse of ["miami", "china"] as const) {
      const snapshot = await captureInventoryValuationSnapshot(db as never, {
        warehouse,
        asOf,
        snapshotType: "month_close",
        note: `manual accounting close ${range.month}`,
        userId: actorId,
      });
      inventorySnapshots.push(snapshot);
    }
    const inserted = await db.raw(
      `INSERT INTO accounting_period_close
         (id, period_start, period_end, revision, status, summary,
          open_documents, readiness, inventory_snapshots, close_note, closed_by_user_id)
       SELECT ?, ?::date, ?::date,
              COALESCE(MAX(revision), 0) + 1, 'closed', ?::jsonb,
              ?::jsonb, ?::jsonb, ?::jsonb, ?, ?
         FROM accounting_period_close
        WHERE period_start = ?::date
       RETURNING *`,
      [
        id,
        range.periodStart,
        range.periodEnd,
        JSON.stringify(summary),
        JSON.stringify(openDocuments),
        JSON.stringify(readiness),
        JSON.stringify(inventorySnapshots),
        body.note?.trim() || null,
        actorId,
        range.periodStart,
      ]
    );
    return res.status(201).json({ close: inserted.rows[0] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("uq_accounting_period_active_close")) {
      return res.status(409).json({
        error: "This month is already closed.",
        code: "month_already_closed",
      });
    }
    throw error;
  }
}
