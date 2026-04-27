/**
 * GET /admin/invoices/top-categories
 * Returns qty + revenue aggregated by top-level product category (children of
 * "BY CATEGORIES") for a date range.
 *
 * Uses a direct SQL query through the pg connection so that the full 2-level
 * category hierarchy is resolved correctly (products are often tagged at L2
 * subcategories like "WHITE LED STRIPS", which must be rolled up to L1 "LED Strips").
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
    WITH by_cat AS (
      SELECT id
      FROM product_category
      WHERE handle = 'by-categories' OR name = 'BY CATEGORIES'
      LIMIT 1
    ),
    l1 AS (
      -- Direct children of BY CATEGORIES (e.g. "LED Strips", "LED Channels", …)
      SELECT id, name, (metadata->>'image')::jsonb->>'url' AS image_url
      FROM product_category
      WHERE parent_category_id = (SELECT id FROM by_cat)
    ),
    l2 AS (
      -- Grandchildren — mapped back to their L1 parent name and image
      SELECT pc.id, l1.name AS l1_name, l1.image_url AS l1_image_url
      FROM product_category pc
      JOIN l1 ON l1.id = pc.parent_category_id
    ),
    cat_map AS (
      -- Union: a category id → its L1 name + image (works for both L1 and L2 entries)
      SELECT id, name AS l1_name, image_url AS l1_image_url FROM l1
      UNION ALL
      SELECT id, l1_name, l1_image_url FROM l2
    ),
    invoice_items AS (
      -- Sales line items (positive sign)
      SELECT pii.variant_id, pii.quantity AS quantity, pii.total AS total
      FROM pos_invoice_item pii
      JOIN pos_invoice pi ON pi.id = pii.invoice_id
      WHERE pi.status IN ('issued', 'partial', 'paid')
        AND pi.created_at >= ?
        AND pi.created_at <= ?
        AND pii.variant_id IS NOT NULL
        AND pii.unit_price > 0
      UNION ALL
      -- Credit memo line items (negative sign — completed returns within range)
      SELECT pcmi.variant_id, -pcmi.quantity AS quantity, -pcmi.line_total AS total
      FROM pos_credit_memo_item pcmi
      JOIN pos_credit_memo pcm ON pcm.id = pcmi.credit_memo_id
      WHERE pcm.status = 'completed'
        AND pcm.created_at >= ?
        AND pcm.created_at <= ?
        AND pcmi.variant_id IS NOT NULL
        AND pcm.deleted_at IS NULL
        AND pcmi.deleted_at IS NULL
    ),
    item_with_category AS (
      SELECT
        ii.quantity,
        ii.total,
        -- Prefer product.metadata->>'main_category' when set and maps to an L1;
        -- fall back to alphabetical MIN of joined categories;
        -- finally label as "Uncategorized" so products without any L1 link still surface.
        COALESCE(main_cat.name, MIN(cm.l1_name), 'Uncategorized') AS l1_category,
        COALESCE(main_cat.image_url, MIN(cm.l1_image_url)) AS l1_image_url
      FROM invoice_items ii
      JOIN product_variant pv ON pv.id = ii.variant_id
      JOIN product p ON p.id = pv.product_id
      LEFT JOIN product_category_product pcp ON pcp.product_id = pv.product_id
      LEFT JOIN cat_map cm ON cm.id = pcp.product_category_id
      LEFT JOIN l1 main_cat ON LOWER(main_cat.name) = LOWER(p.metadata->>'main_category')
      GROUP BY ii.variant_id, ii.quantity, ii.total, main_cat.name, main_cat.image_url
    )
    SELECT
      l1_category AS name,
      SUM(quantity)::int AS qty,
      ROUND(SUM(total) / 100, 2) AS revenue,
      MIN(l1_image_url) AS image_url
    FROM item_with_category
    WHERE l1_category IS NOT NULL
    GROUP BY l1_category
    HAVING SUM(quantity) <> 0 OR SUM(total) <> 0
    ORDER BY revenue DESC;
  `;

  try {
    const result = await pg.raw(sql, [from, to, from, to]);
    const categories = (result.rows ?? []).map((row: any) => ({
      name: row.name,
      qty: Number(row.qty),
      revenue: Number(row.revenue),
      image_url: (row.image_url ?? null) as string | null,
    }));
    res.json({ categories });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[top-categories] SQL error:", msg);
    res.status(500).json({ error: msg });
  }
}
