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
    month?: string;
    input_hash?: string;
    reason?: string;
  };
  const range = parseMonth(body.month);
  if (!range || !body.input_hash || !body.reason?.trim()) {
    return res.status(400).json({
      error: "month, input_hash and reason are required",
      code: "invalid_reopen_request",
    });
  }
  const db = req.scope.resolve("__pg_connection__") as SqlClient;
  const closeRows = await db.raw(
    `SELECT * FROM accounting_period_close
      WHERE period_start = ?::date AND status = 'closed'
      ORDER BY revision DESC LIMIT 1`,
    [range.periodStart]
  );
  const close = closeRows.rows[0];
  if (!close) {
    return res.status(409).json({ error: "This month is not closed." });
  }
  const adjustmentRows = await db.raw(
    `SELECT id, target_period_start
       FROM accounting_period_adjustment
      WHERE source_close_id = ? AND status = 'posted'
      LIMIT 1`,
    [close.id]
  );
  if (adjustmentRows.rows[0]) {
    return res.status(409).json({
      error:
        "This month already has a posted prior-period adjustment. Reverse that adjustment before reopening.",
      code: "posted_adjustment_must_be_reversed_first",
      adjustment: adjustmentRows.rows[0],
    });
  }

  const [current, openDocuments] = await Promise.all([
    loadMonthSummary(db, range),
    loadOpenDocuments(db, range),
  ]);
  const original = normalizeMonthSummary(
    close.summary as Partial<MonthSummary>,
    current
  );
  const previewBody = {
    close_id: close.id,
    revision: close.revision,
    original,
    current,
    delta: summaryDelta(original, current),
    open_documents: openDocuments,
  };
  const currentHash = createHash("sha256")
    .update(JSON.stringify(previewBody))
    .digest("hex");
  if (currentHash !== body.input_hash) {
    return res.status(409).json({
      error: "The accounting data changed after the preview. Generate a fresh preview.",
      code: "reopen_preview_stale",
    });
  }

  const updated = await db.raw(
    `UPDATE accounting_period_close
        SET status = 'reopened', reopened_by_user_id = ?, reopened_at = NOW(),
            reopen_reason = ?, reopen_preview = ?::jsonb, updated_at = NOW()
      WHERE id = ? AND status = 'closed'
      RETURNING *`,
    [
      actorId,
      body.reason.trim(),
      JSON.stringify({ ...previewBody, input_hash: currentHash }),
      close.id,
    ]
  );
  return res.json({ close: updated.rows[0] });
}
