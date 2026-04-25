/**
 * GET  /admin/purchasing/alternatives
 *   Master list: all primary variants that have at least one alternative linked.
 *   Returns variant info + alt count + combined inventory (USA + China).
 *
 * POST /admin/purchasing/alternatives
 *   Link a new alternative to a primary variant.
 *   Body: { primary_variant_id, alt_variant_id, priority? }
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { Client } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

const USA_LOC   = process.env.ECOPOWERTECH_MIAMI_LOCATION_ID  ?? "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const CHINA_LOC = process.env.CHINA_WAREHOUSE_LOCATION_ID     ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

async function getDb() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  return db;
}

// ── GET — master list ────────────────────────────────────────────────────────

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const db = await getDb();
  try {
    const rows = await db.query<{
      primary_variant_id: string;
      sku: string;
      product_title: string;
      alt_count: number;
      inv_usa: number;
      inv_china: number;
      alt_inv_usa: number;
      abc_class: string | null;
      xyz_class: string | null;
    }>(`
      WITH primary_variants AS (
        SELECT DISTINCT primary_variant_id
        FROM product_alternative
        WHERE is_active = true AND deleted_at IS NULL
      ),
      alt_counts AS (
        SELECT primary_variant_id, COUNT(*) AS alt_count
        FROM product_alternative
        WHERE is_active = true AND deleted_at IS NULL
        GROUP BY primary_variant_id
      ),
      inv AS (
        SELECT pvii.variant_id, il.location_id,
               COALESCE(il.stocked_quantity, 0) AS qty
        FROM inventory_level il
        JOIN inventory_item ii ON ii.id = il.inventory_item_id
        JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
        WHERE il.location_id IN ($1, $2)
          AND il.deleted_at IS NULL
          AND ii.deleted_at IS NULL
      ),
      alt_inv AS (
        SELECT pa.primary_variant_id,
               COALESCE(SUM(CASE WHEN inv.location_id = $1 THEN inv.qty ELSE 0 END), 0) AS alt_inv_usa
        FROM product_alternative pa
        JOIN inv ON inv.variant_id = pa.alt_variant_id
        WHERE pa.is_active = true AND pa.deleted_at IS NULL
        GROUP BY pa.primary_variant_id
      )
      SELECT
        pv.id                           AS primary_variant_id,
        pv.sku,
        p.title                         AS product_title,
        ac.alt_count::int,
        COALESCE(SUM(CASE WHEN inv.location_id = $1 THEN inv.qty ELSE 0 END), 0)::int AS inv_usa,
        COALESCE(SUM(CASE WHEN inv.location_id = $2 THEN inv.qty ELSE 0 END), 0)::int AS inv_china,
        COALESCE(ai.alt_inv_usa, 0)::int AS alt_inv_usa,
        snap.abc_class,
        snap.xyz_class
      FROM primary_variants pv_ids
      JOIN product_variant pv ON pv.id = pv_ids.primary_variant_id AND pv.deleted_at IS NULL
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      JOIN alt_counts ac ON ac.primary_variant_id = pv.id
      LEFT JOIN inv ON inv.variant_id = pv.id
      LEFT JOIN alt_inv ai ON ai.primary_variant_id = pv.id
      LEFT JOIN purchasing_snapshot snap ON snap.variant_id = pv.id
      GROUP BY pv.id, pv.sku, p.title, ac.alt_count, ai.alt_inv_usa, snap.abc_class, snap.xyz_class
      ORDER BY pv.sku
    `, [USA_LOC, CHINA_LOC]);

    return res.json({ alternatives: rows.rows, count: rows.rowCount });
  } finally {
    await db.end();
  }
}

// ── POST — create link ───────────────────────────────────────────────────────

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const body = req.body as {
    primary_variant_id?: string;
    alt_variant_id?: string;
    priority?: number;
  };

  const { primary_variant_id, alt_variant_id, priority = 1 } = body;

  if (!primary_variant_id || !alt_variant_id) {
    return res.status(400).json({ error: "primary_variant_id and alt_variant_id are required" });
  }
  if (primary_variant_id === alt_variant_id) {
    return res.status(400).json({ error: "A variant cannot be its own alternative" });
  }

  const db = await getDb();
  try {
    // Verify both variants exist
    const check = await db.query<{ id: string }>(
      `SELECT id FROM product_variant WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [[primary_variant_id, alt_variant_id]]
    );
    if (check.rowCount !== 2) {
      return res.status(404).json({ error: "One or both variant IDs not found" });
    }

    const id = `palt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    await db.query(`
      INSERT INTO product_alternative
        (id, primary_variant_id, alt_variant_id, priority, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, true, now(), now())
      ON CONFLICT (primary_variant_id, alt_variant_id)
      DO UPDATE SET priority = EXCLUDED.priority, is_active = true, updated_at = now()
    `, [id, primary_variant_id, alt_variant_id, priority]);

    return res.status(201).json({ ok: true });
  } finally {
    await db.end();
  }
}
