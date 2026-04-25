/**
 * GET    /admin/purchasing/alternatives/:id  — get alternatives for a primary variant
 * DELETE /admin/purchasing/alternatives/:id  — remove an alternative link
 *
 * :id can be either:
 *  - a product_alternative.id  (for DELETE)
 *  - a product_variant.id      (for GET — returns all alternatives of that primary)
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

// ── GET — alternatives for a primary variant ─────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const variantId = (req.params as Record<string, string>).id;
  const db = await getDb();

  try {
    // Primary variant info
    const primaryRow = await db.query<{
      id: string; sku: string; product_title: string; product_id: string;
      inv_usa: number; inv_china: number; abc_class: string | null; xyz_class: string | null;
    }>(`
      SELECT
        pv.id, pv.sku,
        p.title AS product_title,
        p.id    AS product_id,
        COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0)::int AS inv_usa,
        COALESCE(SUM(CASE WHEN il.location_id = $3 THEN il.stocked_quantity ELSE 0 END), 0)::int AS inv_china,
        snap.abc_class,
        snap.xyz_class
      FROM product_variant pv
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
      LEFT JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
      LEFT JOIN inventory_level il ON il.inventory_item_id = ii.id
        AND il.location_id IN ($2, $3) AND il.deleted_at IS NULL
      LEFT JOIN purchasing_snapshot snap ON snap.variant_id = pv.id
      WHERE pv.id = $1 AND pv.deleted_at IS NULL
      GROUP BY pv.id, pv.sku, p.title, p.id, snap.abc_class, snap.xyz_class
    `, [variantId, USA_LOC, CHINA_LOC]);

    if (!primaryRow.rows.length) {
      return res.status(404).json({ error: "Variant not found" });
    }

    // Alternatives list
    const altsRows = await db.query<{
      link_id: string; priority: number;
      variant_id: string; sku: string; product_title: string;
      inv_usa: number; inv_china: number;
      abc_class: string | null; xyz_class: string | null;
    }>(`
      SELECT
        pa.id         AS link_id,
        pa.priority,
        pv.id         AS variant_id,
        pv.sku,
        p.title       AS product_title,
        COALESCE(SUM(CASE WHEN il.location_id = $2 THEN il.stocked_quantity ELSE 0 END), 0)::int AS inv_usa,
        COALESCE(SUM(CASE WHEN il.location_id = $3 THEN il.stocked_quantity ELSE 0 END), 0)::int AS inv_china,
        snap.abc_class,
        snap.xyz_class
      FROM product_alternative pa
      JOIN product_variant pv ON pv.id = pa.alt_variant_id AND pv.deleted_at IS NULL
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
      LEFT JOIN inventory_item ii ON ii.id = pvii.inventory_item_id AND ii.deleted_at IS NULL
      LEFT JOIN inventory_level il ON il.inventory_item_id = ii.id
        AND il.location_id IN ($2, $3) AND il.deleted_at IS NULL
      LEFT JOIN purchasing_snapshot snap ON snap.variant_id = pv.id
      WHERE pa.primary_variant_id = $1
        AND pa.is_active = true AND pa.deleted_at IS NULL
        AND pv.deleted_at IS NULL
      GROUP BY pa.id, pa.priority, pv.id, pv.sku, p.title, snap.abc_class, snap.xyz_class
      ORDER BY pa.priority ASC, pv.sku
    `, [variantId, USA_LOC, CHINA_LOC]);

    // Reverse links: where this variant is listed as an alternative of others
    const reverseRows = await db.query<{
      link_id: string; primary_variant_id: string; primary_sku: string; primary_title: string;
    }>(`
      SELECT pa.id AS link_id, pv.id AS primary_variant_id, pv.sku AS primary_sku, p.title AS primary_title
      FROM product_alternative pa
      JOIN product_variant pv ON pv.id = pa.primary_variant_id AND pv.deleted_at IS NULL
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      WHERE pa.alt_variant_id = $1 AND pa.is_active = true AND pa.deleted_at IS NULL
      ORDER BY pv.sku
    `, [variantId]);

    return res.json({
      primary: primaryRow.rows[0],
      alternatives: altsRows.rows,
      reverse_links: reverseRows.rows,
    });
  } finally {
    await db.end();
  }
}

// ── DELETE — remove a link ───────────────────────────────────────────────────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const linkId = (req.params as Record<string, string>).id;
  const db = await getDb();

  try {
    const result = await db.query(
      `UPDATE product_alternative
       SET is_active = false, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [linkId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Link not found" });
    }

    return res.json({ ok: true });
  } finally {
    await db.end();
  }
}
