import { createHash } from "node:crypto";

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  loadMonthSummary,
  loadOpenDocuments,
  normalizeMonthSummary,
  parseMonth,
  summaryDelta,
  type MonthSummary,
  type SqlClient,
} from "../../../../../lib/accounting/month-close-data";
import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorId: string;
  try {
    actorId = await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const body = req.body as {
    source_month?: string;
    target_month?: string;
    input_hash?: string;
    reason?: string;
  };
  const source = parseMonth(body.source_month);
  const target = parseMonth(body.target_month);
  if (!source || !target || !body.input_hash || !body.reason?.trim()) {
    return res.status(400).json({
      error: "source_month, target_month, input_hash and reason are required",
    });
  }
  if (target.periodStart <= source.periodStart) {
    return res.status(409).json({
      error: "The adjustment must be posted to a later open month.",
      code: "adjustment_target_not_later",
    });
  }

  const db = req.scope.resolve("__pg_connection__") as SqlClient;
  const [sourceCloseRows, targetCloseRows] = await Promise.all([
    db.raw(
      `SELECT * FROM accounting_period_close
        WHERE period_start = ?::date AND status = 'closed'
        ORDER BY revision DESC LIMIT 1`,
      [source.periodStart]
    ),
    db.raw(
      `SELECT id FROM accounting_period_close
        WHERE period_start = ?::date AND status = 'closed' LIMIT 1`,
      [target.periodStart]
    ),
  ]);
  const close = sourceCloseRows.rows[0] as
    | {
        id: string;
        revision: number;
        summary: MonthSummary;
      }
    | undefined;
  if (!close) {
    return res.status(409).json({ error: "The source month is not closed." });
  }
  if (targetCloseRows.rows[0]) {
    return res.status(409).json({
      error: "The target month is closed.",
      code: "adjustment_target_closed",
    });
  }

  const [current, openDocuments] = await Promise.all([
    loadMonthSummary(db, source),
    loadOpenDocuments(db, source),
  ]);
  const original = normalizeMonthSummary(
    close.summary as Partial<MonthSummary>,
    current
  );
  const delta = summaryDelta(original, current);
  const hashBody = {
    close_id: close.id,
    revision: close.revision,
    original,
    current,
    delta,
    open_documents: openDocuments,
  };
  const currentHash = createHash("sha256")
    .update(JSON.stringify(hashBody))
    .digest("hex");
  if (currentHash !== body.input_hash) {
    return res.status(409).json({
      error: "The delta changed. Generate a fresh preview before posting it.",
      code: "delta_preview_stale",
    });
  }

  const id = `apa_${close.id.slice(-16)}_${Date.now().toString(36)}`;
  try {
    const inserted = await db.raw(
      `INSERT INTO accounting_period_adjustment
         (id, source_close_id, target_period_start, target_period_end, delta,
          source_input_hash, reason, posted_by_user_id)
       VALUES (?, ?, ?::date, ?::date, ?::jsonb, ?, ?, ?)
       RETURNING *`,
      [
        id,
        close.id,
        target.periodStart,
        target.periodEnd,
        JSON.stringify(delta),
        currentHash,
        body.reason.trim(),
        actorId,
      ]
    );
    return res.status(201).json({ adjustment: inserted.rows[0] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("uq_accounting_period_adjustment_source")) {
      return res.status(409).json({
        error: "This closed-period delta already has an active adjustment.",
        code: "delta_already_resolved",
      });
    }
    throw error;
  }
}
