/**
 * src/api/admin/dashboard/top-products/route.ts
 * GET /admin/dashboard/top-products?from=ISO&to=ISO
 *
 * Returns top-selling products for the given date range,
 * aggregated directly in PostgreSQL — fast regardless of range size.
 * Replaces the slow client-side approach of fetching all /admin/orders.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Client } from "pg";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { from, to } = req.query as { from?: string; to?: string };

  if (!from || !to) {
    return res
      .status(400)
      .json({ error: "from and to query params are required (ISO 8601)" });
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();

    const { rows } = await client.query<{
      variant_id: string | null;
      title: string;
      sku: string | null;
      thumbnail: string | null;
      qty_sold: string;
      revenue: string;
    }>(
      `
            SELECT
                oi_line.variant_id,
                oi_line.title,
                oi_line.variant_sku   AS sku,
                oi_line.thumbnail,
                SUM(oi.quantity)::int                         AS qty_sold,
                SUM(oi_line.unit_price * oi.quantity)::float  AS revenue
            FROM   order_item oi
            JOIN   order_line_item oi_line ON oi_line.id = oi.item_id
            JOIN   "order" o              ON o.id        = oi.order_id
            WHERE  o.created_at  BETWEEN $1 AND $2
            AND    o.status      IN ('pending', 'requires_action', 'completed')
            AND    o.deleted_at  IS NULL
            GROUP  BY oi_line.variant_id, oi_line.title, oi_line.variant_sku, oi_line.thumbnail
            ORDER  BY revenue DESC
            LIMIT  20
            `,
      [from, to]
    );

    return res.json({
      products: rows.map((r) => ({
        variant_id: r.variant_id,
        title: r.title,
        sku: r.sku ?? "",
        thumbnail: r.thumbnail ?? null,
        qty_sold: Number(r.qty_sold),
        revenue: Number(r.revenue),
      })),
    });
  } catch (err: any) {
    const logger = (req.scope as any).resolve?.("logger");
    logger?.error?.(`[dashboard/top-products] ${err.message}`);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.end().catch(() => {
      /* ignore */
    });
  }
}
