/**
 * GET /admin/dashboard/customer-breakdown?from=ISO&to=ISO
 *
 * Customer-focused dashboard slices for the POS date range selector.
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

const ACTIVE_INVOICE_STATUSES_SQL = `
  'issued',
  'partial',
  'paid',
  'partially_refunded',
  'refunded'
`;

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

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

  const customersByDaySql = `
    SELECT
      DATE(pi.created_at)::text AS day,
      COUNT(pi.id)::int AS transactions,
      COUNT(DISTINCT pi.customer_id)::int AS customers
    FROM pos_invoice pi
    WHERE pi.status IN (${ACTIVE_INVOICE_STATUSES_SQL})
      AND pi.created_at >= ?
      AND pi.created_at <= ?
      AND pi.deleted_at IS NULL
    GROUP BY DATE(pi.created_at)
    ORDER BY day;
  `;

  const groupedSalesSql = (groupExpr: string) => `
    WITH invoice_sales AS (
      SELECT
        pi.customer_id,
        SUM(GREATEST(
          COALESCE(pi.total, 0) - COALESCE(pi.tax, 0) - COALESCE(pi.shipping, 0),
          0
        )) AS sales_cents
      FROM pos_invoice pi
      WHERE pi.status IN (${ACTIVE_INVOICE_STATUSES_SQL})
        AND pi.created_at >= ?
        AND pi.created_at <= ?
        AND pi.deleted_at IS NULL
        AND pi.customer_id IS NOT NULL
      GROUP BY pi.customer_id
    ),
    return_sales AS (
      SELECT
        pcm.customer_id,
        SUM(COALESCE(pcm.subtotal, GREATEST(
          COALESCE(pcm.total, 0) - COALESCE(pcm.tax, 0) - COALESCE(pcm.shipping, 0),
          0
        ))) AS return_cents
      FROM pos_credit_memo pcm
      WHERE pcm.status = 'completed'
        AND pcm.created_at >= ?
        AND pcm.created_at <= ?
        AND pcm.deleted_at IS NULL
        AND pcm.customer_id IS NOT NULL
      GROUP BY pcm.customer_id
    ),
    customer_net AS (
      SELECT
        c.id,
        c.metadata,
        GREATEST(
          COALESCE(invoice_sales.sales_cents, 0) - COALESCE(return_sales.return_cents, 0),
          0
        ) AS net_cents
      FROM customer c
      LEFT JOIN invoice_sales ON invoice_sales.customer_id = c.id
      LEFT JOIN return_sales ON return_sales.customer_id = c.id
      WHERE invoice_sales.customer_id IS NOT NULL OR return_sales.customer_id IS NOT NULL
    )
    SELECT
      ${groupExpr} AS name,
      ROUND(SUM(net_cents) / 100, 2) AS value
    FROM customer_net
    WHERE net_cents > 0
    GROUP BY name
    ORDER BY value DESC;
  `;

  try {
    const [customersByDayResult, typeSalesResult, acquisitionSalesResult] =
      await Promise.all([
        pg.raw(customersByDaySql, [from, to]),
        pg.raw(
          groupedSalesSql(
            `COALESCE(
              NULLIF(metadata->>'qb_customer_type', ''),
              NULLIF(metadata->>'customer_type', ''),
              'Standard'
            )`
          ),
          [from, to, from, to]
        ),
        pg.raw(
          groupedSalesSql(
            `COALESCE(NULLIF(metadata->>'acquisition_channel', ''), 'Unknown')`
          ),
          [from, to, from, to]
        ),
      ]);

    res.json({
      customers_by_day: (customersByDayResult.rows ?? []).map((row: any) => ({
        name: row.day,
        value: asNumber(row.customers),
        transactions: asNumber(row.transactions),
      })),
      customer_type_sales: (typeSalesResult.rows ?? []).map((row: any) => ({
        name: String(row.name ?? "Standard"),
        value: asNumber(row.value),
      })),
      acquisition_sales: (acquisitionSalesResult.rows ?? []).map((row: any) => ({
        name: String(row.name ?? "Unknown"),
        value: asNumber(row.value),
      })),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[dashboard/customer-breakdown] SQL error:", msg);
    res.status(500).json({ error: msg });
  }
}
