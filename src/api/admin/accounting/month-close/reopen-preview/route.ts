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

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    await requireFullAdmin(req);
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const range = parseMonth(req.query.month);
  if (!range) {
    return res.status(400).json({ error: "month is required in YYYY-MM format" });
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
    return res.status(409).json({
      error: "This month is not closed.",
      code: "month_not_closed",
    });
  }

  const [current, openDocuments, causes] = await Promise.all([
    loadMonthSummary(db, range),
    loadOpenDocuments(db, range),
    db.raw(
      `SELECT
         (SELECT COUNT(DISTINCT vendor_bill_id) FROM variant_cost_event
           WHERE recorded_at > ? AND effective_at >= ? AND effective_at < ?)::int AS bills,
         (SELECT COUNT(DISTINCT product_variant_id) FROM variant_cost_event
           WHERE recorded_at > ? AND effective_at >= ? AND effective_at < ?)::int AS products,
         (SELECT COUNT(DISTINCT source_document_id) FROM sale_cost_adjustment
           WHERE created_at > ? AND created_at < NOW())::int AS invoices`,
      [
        close.closed_at, range.from, range.to,
        close.closed_at, range.from, range.to,
        close.closed_at,
      ]
    ),
  ]);
  const original = normalizeMonthSummary(
    close.summary as Partial<MonthSummary>,
    current
  );
  const hashBody = {
    close_id: close.id,
    revision: close.revision,
    original,
    current,
    delta: summaryDelta(original, current),
    open_documents: openDocuments,
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(hashBody))
    .digest("hex");
  return res.json({
    preview: {
      ...hashBody,
      causes: causes.rows[0] ?? { bills: 0, products: 0, invoices: 0 },
      generated_at: new Date().toISOString(),
      input_hash: inputHash,
    },
  });
}
