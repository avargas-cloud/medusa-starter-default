/**
 * GET /admin/invoices/top-customers
 * Returns invoice count + revenue aggregated by customer for a date range.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

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
    SELECT
      c.id,
      TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
      c.company_name AS company,
      COUNT(DISTINCT pi.id)::int AS invoice_count,
      ROUND(SUM(pi.total) / 100, 2) AS revenue
    FROM pos_invoice pi
    JOIN customer c ON c.id = pi.customer_id
    WHERE pi.status IN ('issued', 'partial', 'paid')
      AND pi.created_at >= ?
      AND pi.created_at <= ?
    GROUP BY c.id, c.first_name, c.last_name, c.company_name
    ORDER BY revenue DESC
    LIMIT 30;
  `;

  try {
    const result = await pg.raw(sql, [from, to]);
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
