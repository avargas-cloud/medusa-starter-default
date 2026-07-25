import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth";
import type { SqlClient } from "../../../../../lib/accounting/month-close-data";

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
    adjustment_id?: string;
    reason?: string;
  };
  if (!body.adjustment_id || !body.reason?.trim()) {
    return res.status(400).json({
      error: "adjustment_id and reason are required",
      code: "adjustment_reversal_invalid",
    });
  }

  const db = req.scope.resolve("__pg_connection__") as SqlClient;
  const adjustmentRows = await db.raw(
    `SELECT a.*, c.period_start AS source_period_start
       FROM accounting_period_adjustment a
       JOIN accounting_period_close c ON c.id = a.source_close_id
      WHERE a.id = ?`,
    [body.adjustment_id]
  );
  const adjustment = adjustmentRows.rows[0] as
    | {
        id: string;
        status: string;
        qb_status: string;
        target_period_start: string;
      }
    | undefined;
  if (!adjustment) {
    return res.status(404).json({
      error: "Prior-period adjustment not found.",
      code: "adjustment_not_found",
    });
  }
  if (adjustment.status !== "posted") {
    return res.status(409).json({
      error: "This adjustment has already been reversed.",
      code: "adjustment_already_reversed",
    });
  }
  if (adjustment.qb_status !== "not_posted") {
    return res.status(409).json({
      error:
        "This adjustment has QuickBooks activity and must be reversed through the accounting integration first.",
      code: "adjustment_qb_reversal_required",
    });
  }

  const targetClose = await db.raw(
    `SELECT id FROM accounting_period_close
      WHERE period_start = ?::date AND status = 'closed'
      LIMIT 1`,
    [adjustment.target_period_start]
  );
  if (targetClose.rows[0]) {
    return res.status(409).json({
      error: "Reopen the adjustment's target month before reversing it.",
      code: "adjustment_target_closed",
    });
  }

  const reversed = await db.raw(
    `UPDATE accounting_period_adjustment
        SET status = 'reversed',
            reversed_by_user_id = ?,
            reversed_at = NOW(),
            reversal_reason = ?,
            updated_at = NOW()
      WHERE id = ? AND status = 'posted'
      RETURNING *`,
    [actorId, body.reason.trim(), adjustment.id]
  );
  if (!reversed.rows[0]) {
    return res.status(409).json({
      error: "This adjustment changed while it was being reversed. Refresh and try again.",
      code: "adjustment_reversal_conflict",
    });
  }

  return res.json({ adjustment: reversed.rows[0] });
}
