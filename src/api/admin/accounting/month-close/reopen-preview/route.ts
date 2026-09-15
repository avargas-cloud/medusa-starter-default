import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  parseMonth,
  type SqlClient,
} from "../../../../../lib/accounting/month-close-data";
import { monthReopenPreview } from "../../../../../lib/accounting/month-close-reopen";
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
  const preview = await monthReopenPreview(db, range);
  if (!preview) {
    return res.status(409).json({
      error: "This month is not closed.",
      code: "month_not_closed",
    });
  }
  const causes = await db.raw(
    `SELECT
       (SELECT COUNT(DISTINCT vendor_bill_id) FROM variant_cost_event
         WHERE recorded_at > ? AND effective_at >= ? AND effective_at < ?)::int AS bills,
       (SELECT COUNT(DISTINCT product_variant_id) FROM variant_cost_event
         WHERE recorded_at > ? AND effective_at >= ? AND effective_at < ?)::int AS products,
       (SELECT COUNT(DISTINCT source_document_id) FROM sale_cost_adjustment
         WHERE created_at > ? AND created_at < NOW())::int AS invoices`,
    [
      preview.close.closed_at, range.from, range.to,
      preview.close.closed_at, range.from, range.to,
      preview.close.closed_at,
    ]
  );
  return res.json({
    preview: {
      ...preview.body,
      causes: causes.rows[0] ?? { bills: 0, products: 0, invoices: 0 },
      generated_at: new Date().toISOString(),
      input_hash: preview.input_hash,
    },
  });
}
