/**
 * GET /admin/purchasing/snapshot/:variantId
 *
 * Returns the snapshot for a single variant, including alt context.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Client } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

async function getDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  return db;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { variantId } = req.params as Record<string, string>;
  const db = await getDb();

  try {
    const row = await db.query(
      `SELECT
         snap.*,
         pv.sku,
         p.title AS product_title,
         p.id    AS product_id
       FROM purchasing_snapshot snap
       JOIN product_variant pv ON pv.id = snap.variant_id AND pv.deleted_at IS NULL
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       WHERE snap.variant_id = $1`,
      [variantId]
    );

    if (!row.rows.length) {
      return res.status(404).json({ error: "Snapshot not found for this variant" });
    }

    // Monthly sales history for the sparkline chart
    const history = await db.query(
      `SELECT month_date::text, COALESCE(SUM(qty_sold), 0)::int AS qty_sold
       FROM purchasing_sales_history
       WHERE variant_id = $1
         AND month_date >= (NOW() - INTERVAL '12 months')::date
       GROUP BY month_date
       ORDER BY month_date`,
      [variantId]
    );

    return res.json({
      snapshot: row.rows[0],
      history: history.rows,
    });
  } finally {
    await db.end();
  }
}
