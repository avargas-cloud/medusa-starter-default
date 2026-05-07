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

import { withDb } from "../_lib/db";

const USA_LOC =
  process.env.ECOPOWERTECH_MIAMI_LOCATION_ID ??
  "sloc_01KFS2AV3TAKR141KC2D6JCGTR";
const CHINA_LOC =
  process.env.CHINA_WAREHOUSE_LOCATION_ID ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

// ── GET — master list ────────────────────────────────────────────────────────

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  return withDb(async (db) => {
    const rows = await db.query<{
      primary_variant_id: string;
      sku: string;
      product_title: string;
      sales_description: string;
      alt_count: number;
      inv_usa: number;
      inv_china: number;
      alt_inv_usa: number;
      alt_inv_usa_reserved: number;
      alt_qty_on_po: number;
      abc_class: string | null;
      xyz_class: string | null;
    }>(
      `
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
               COALESCE(il.stocked_quantity, 0) AS qty,
               COALESCE(il.reserved_quantity, 0) AS reserved
        FROM inventory_level il
        JOIN inventory_item ii ON ii.id = il.inventory_item_id
        JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
        WHERE il.location_id IN ($1, $2)
          AND il.deleted_at IS NULL
          AND ii.deleted_at IS NULL
      ),
      open_po_usa AS (
        SELECT pol.sku_snapshot,
               SUM(GREATEST(0, pol.qty_ordered - pol.qty_received - pol.qty_cancelled))::int AS on_order
        FROM purchase_order_line pol
        JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
        WHERE po.status IN ('submitted', 'partially_received')
          AND pol.status IN ('open', 'partial')
          AND pol.deleted_at IS NULL
          AND BTRIM(po.stock_location_id, E' \\t\\n\\r') = $1
        GROUP BY pol.sku_snapshot
      ),
      alt_inv AS (
        SELECT pa.primary_variant_id,
               COALESCE(SUM(CASE WHEN inv.location_id = $1 THEN inv.qty ELSE 0 END), 0)::int AS alt_inv_usa,
               COALESCE(SUM(CASE WHEN inv.location_id = $1 THEN inv.reserved ELSE 0 END), 0)::int AS alt_inv_usa_reserved
        FROM product_alternative pa
        JOIN inv ON inv.variant_id = pa.alt_variant_id
        WHERE pa.is_active = true AND pa.deleted_at IS NULL
        GROUP BY pa.primary_variant_id
      ),
      alt_po AS (
        SELECT pa.primary_variant_id,
               COALESCE(SUM(open_po_usa.on_order), 0)::int AS alt_qty_on_po
        FROM product_alternative pa
        JOIN product_variant pv_alt ON pv_alt.id = pa.alt_variant_id AND pv_alt.deleted_at IS NULL
        LEFT JOIN open_po_usa ON open_po_usa.sku_snapshot = pv_alt.sku
        WHERE pa.is_active = true AND pa.deleted_at IS NULL
        GROUP BY pa.primary_variant_id
      )
      SELECT
        pv.id                           AS primary_variant_id,
        pv.sku,
        p.title                         AS product_title,
        COALESCE(pv.metadata->>'sales_description', '') AS sales_description,
        ac.alt_count::int,
        COALESCE(SUM(CASE WHEN inv.location_id = $1 THEN inv.qty ELSE 0 END), 0)::int AS inv_usa,
        COALESCE(SUM(CASE WHEN inv.location_id = $2 THEN GREATEST(0, inv.qty - inv.reserved) ELSE 0 END), 0)::int AS inv_china,
        COALESCE(ai.alt_inv_usa, 0)::int AS alt_inv_usa,
        COALESCE(ai.alt_inv_usa_reserved, 0)::int AS alt_inv_usa_reserved,
        COALESCE(apo.alt_qty_on_po, 0)::int AS alt_qty_on_po,
        snap.abc_class,
        snap.xyz_class
      FROM primary_variants pv_ids
      JOIN product_variant pv ON pv.id = pv_ids.primary_variant_id AND pv.deleted_at IS NULL
      JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
      JOIN alt_counts ac ON ac.primary_variant_id = pv.id
      LEFT JOIN inv ON inv.variant_id = pv.id
      LEFT JOIN alt_inv ai ON ai.primary_variant_id = pv.id
      LEFT JOIN alt_po apo ON apo.primary_variant_id = pv.id
      LEFT JOIN purchasing_snapshot snap ON snap.variant_id = pv.id
      GROUP BY pv.id, pv.sku, p.title, pv.metadata, ac.alt_count,
               ai.alt_inv_usa, ai.alt_inv_usa_reserved, apo.alt_qty_on_po,
               snap.abc_class, snap.xyz_class
      ORDER BY pv.sku
    `,
      [USA_LOC, CHINA_LOC]
    );

    return res.json({ alternatives: rows.rows, count: rows.rowCount });
  });
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
    return res
      .status(400)
      .json({ error: "primary_variant_id and alt_variant_id are required" });
  }
  if (primary_variant_id === alt_variant_id) {
    return res
      .status(400)
      .json({ error: "A variant cannot be its own alternative" });
  }

  return withDb(async (db) => {
    // Verify both variants exist
    const check = await db.query<{ id: string }>(
      `SELECT id FROM product_variant WHERE id = ANY($1::text[]) AND deleted_at IS NULL`,
      [[primary_variant_id, alt_variant_id]]
    );
    if (check.rowCount !== 2) {
      return res
        .status(404)
        .json({ error: "One or both variant IDs not found" });
    }

    // Guard: the proposed primary cannot itself be an alt of another product.
    // This prevents ambiguous chains (A→B→C) where B is both alt and primary.
    const primaryIsAlt = await db.query<{
      owner_sku: string;
      owner_title: string;
      owner_variant_id: string;
    }>(
      `
      SELECT
        pv_owner.id    AS owner_variant_id,
        pv_owner.sku   AS owner_sku,
        p_owner.title  AS owner_title
      FROM product_alternative pa
      JOIN product_variant pv_owner ON pv_owner.id = pa.primary_variant_id AND pv_owner.deleted_at IS NULL
      JOIN product p_owner          ON p_owner.id  = pv_owner.product_id   AND p_owner.deleted_at IS NULL
      WHERE pa.alt_variant_id = $1 AND pa.is_active = true AND pa.deleted_at IS NULL
      LIMIT 1
      `,
      [primary_variant_id]
    );
    if ((primaryIsAlt.rowCount ?? 0) > 0) {
      const owner = primaryIsAlt.rows[0]!;
      return res.status(409).json({
        error: "already_an_alternative",
        message: `This product is already an alternative of "${owner.owner_sku}". A product that belongs to another product's alternative set cannot be registered as a primary.`,
        owner: {
          variant_id: owner.owner_variant_id,
          sku: owner.owner_sku,
          title: owner.owner_title,
        },
      });
    }

    // Guard: the proposed alt cannot already be linked as an alt of a different
    // primary. Sharing the same alt across multiple primaries is forbidden — each
    // alt belongs to exactly one primary group.
    const altAlreadyLinked = await db.query<{
      owner_variant_id: string;
      owner_sku: string;
      owner_title: string;
      alt_sku: string;
    }>(
      `
      SELECT
        pv_owner.id   AS owner_variant_id,
        pv_owner.sku  AS owner_sku,
        p_owner.title AS owner_title,
        pv_alt.sku    AS alt_sku
      FROM product_alternative pa
      JOIN product_variant pv_owner ON pv_owner.id = pa.primary_variant_id AND pv_owner.deleted_at IS NULL
      JOIN product p_owner          ON p_owner.id  = pv_owner.product_id   AND p_owner.deleted_at IS NULL
      JOIN product_variant pv_alt   ON pv_alt.id   = pa.alt_variant_id     AND pv_alt.deleted_at IS NULL
      WHERE pa.alt_variant_id = $1
        AND pa.primary_variant_id <> $2
        AND pa.is_active = true
        AND pa.deleted_at IS NULL
      LIMIT 1
      `,
      [alt_variant_id, primary_variant_id]
    );
    if ((altAlreadyLinked.rowCount ?? 0) > 0) {
      const owner = altAlreadyLinked.rows[0]!;
      return res.status(409).json({
        error: "alt_already_linked",
        message: `"${owner.alt_sku}" is already an alternative of "${owner.owner_sku}". Each alternative can only belong to one primary — remove it from "${owner.owner_sku}" first or merge that primary into this one.`,
        owner: {
          variant_id: owner.owner_variant_id,
          sku: owner.owner_sku,
          title: owner.owner_title,
        },
      });
    }

    // Guard: the proposed alt cannot already have its own alternatives registered.
    // Adding an alt that is itself a primary creates the same chain problem.
    const altHasOwnAlts = await db.query<{ alt_sku: string; n: string }>(
      `
      SELECT pv.sku AS alt_sku, COUNT(*) AS n
      FROM product_alternative pa
      JOIN product_variant pv ON pv.id = pa.primary_variant_id AND pv.deleted_at IS NULL
      WHERE pa.primary_variant_id = $1 AND pa.is_active = true AND pa.deleted_at IS NULL
      GROUP BY pv.sku
      `,
      [alt_variant_id]
    );
    if ((altHasOwnAlts.rowCount ?? 0) > 0) {
      const { alt_sku, n } = altHasOwnAlts.rows[0]!;
      return res.status(409).json({
        error: "alt_has_own_alternatives",
        message: `"${alt_sku}" is already registered as a primary with ${n} alternative(s) of its own. Clean up those links first, or add its alternatives directly to the current primary instead.`,
        alt_sku,
        own_alt_count: parseInt(n, 10),
      });
    }

    const id = `palt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    await db.query(
      `
      INSERT INTO product_alternative
        (id, primary_variant_id, alt_variant_id, priority, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, true, now(), now())
      ON CONFLICT (primary_variant_id, alt_variant_id)
      DO UPDATE SET priority = EXCLUDED.priority, is_active = true, updated_at = now()
    `,
      [id, primary_variant_id, alt_variant_id, priority]
    );

    return res.status(201).json({ ok: true });
  });
}
