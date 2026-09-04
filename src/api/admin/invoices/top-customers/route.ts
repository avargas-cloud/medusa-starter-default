/**
 * GET /admin/invoices/top-customers
 * Returns invoice count + revenue aggregated by customer for a date range.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { cmNotFraudWriteoffSql } from "../../../../lib/reports/fraud-writeoff"

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { from, to } = req.query as Record<string, string>;

  if (!from || !to) {
    res.status(400).json({ error: "from and to query params are required" });
    return;
  }

  const pg = req.scope.resolve("__pg_connection__") as any;

  const sql = `
    WITH inv_agg AS (
      SELECT
        pi.customer_id,
        COUNT(DISTINCT pi.id)::int AS invoice_count,
        SUM(pi.total) AS revenue_cents
      FROM pos_invoice pi
      WHERE pi.status IN ('issued', 'partial', 'paid')
        AND pi.created_at >= ?
        AND pi.created_at <= ?
        AND pi.customer_id IS NOT NULL
      GROUP BY pi.customer_id
    ),
    cm_agg AS (
      SELECT
        pcm.customer_id,
        SUM(pcm.total) AS refund_cents
      FROM pos_credit_memo pcm
      WHERE pcm.status = 'completed'
        AND ${cmNotFraudWriteoffSql("pcm")}
        AND pcm.created_at >= ?
        AND pcm.created_at <= ?
        AND pcm.customer_id IS NOT NULL
        AND pcm.deleted_at IS NULL
      GROUP BY pcm.customer_id
    )
    SELECT
      c.id,
      TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
      c.company_name AS company,
      COALESCE(inv_agg.invoice_count, 0) AS invoice_count,
      ROUND((COALESCE(inv_agg.revenue_cents, 0) - COALESCE(cm_agg.refund_cents, 0)) / 100, 2) AS revenue
    FROM customer c
    LEFT JOIN inv_agg ON inv_agg.customer_id = c.id
    LEFT JOIN cm_agg ON cm_agg.customer_id = c.id
    WHERE inv_agg.customer_id IS NOT NULL OR cm_agg.customer_id IS NOT NULL
    ORDER BY revenue DESC
    LIMIT 30;
  `;

  try {
    const result = await pg.raw(sql, [from, to, from, to]);
    const customers = (result.rows ?? []).map((row: any) => ({
      id: row.id,
      name: row.name as string,
      company: (row.company ?? null) as string | null,
      invoice_count: Number(row.invoice_count),
      revenue: Number(row.revenue),
    }));
    res.json({ customers });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[top-customers] SQL error:", msg);
    res.status(500).json({ error: msg });
  }
}
