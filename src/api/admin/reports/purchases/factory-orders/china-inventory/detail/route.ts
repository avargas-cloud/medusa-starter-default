import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'
const ROOT_CAT   = 'pcat_01KGAD1KQV29RKZZHEZ4N88B8H'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH tier1 AS (
         SELECT DISTINCT ON (pcp.product_id)
           pcp.product_id,
           COALESCE(
             CASE WHEN pc.parent_category_id = '${ROOT_CAT}' THEN pc.name END,
             CASE WHEN pc2.parent_category_id = '${ROOT_CAT}' THEN pc2.name END,
             'Uncategorized'
           ) AS category
         FROM product_category_product pcp
         JOIN product_category pc ON pc.id = pcp.product_category_id
         LEFT JOIN product_category pc2 ON pc2.id = pc.parent_category_id
         ORDER BY pcp.product_id, pc.name
       )
       SELECT
         pv.id                                                                    AS variant_id,
         COALESCE(NULLIF(pv.sku,''), ii.sku)                                     AS sku,
         p.title                                                                  AS description,
         COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'),''), 'Unknown') AS factory,
         COALESCE(t1.category, 'Uncategorized')                                  AS category,
         il.stocked_quantity::int                                                 AS qty,
         COALESCE(
           (pv.metadata->>'average_unit_cost')::numeric,
           (pv.metadata->>'qb_avg_cost')::numeric,
           0
         )                                                                        AS unit_cost,
         ROUND(il.stocked_quantity * COALESCE(
           (pv.metadata->>'average_unit_cost')::numeric,
           (pv.metadata->>'qb_avg_cost')::numeric,
           0
         )::numeric, 2)                                                          AS total_value
       FROM inventory_level il
       JOIN inventory_item ii ON ii.id = il.inventory_item_id
       JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
       JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       LEFT JOIN tier1 t1 ON t1.product_id = p.id
       WHERE il.location_id = '${CHINA_SLOC}' AND il.stocked_quantity > 0
       ORDER BY total_value DESC, factory, sku`
    )

    const rows = (result.rows as any[]).map(r => ({
      variant_id:  r.variant_id as string,
      sku:         r.sku as string,
      description: r.description as string,
      factory:     r.factory as string,
      category:    r.category as string,
      qty:         Number(r.qty),
      unit_cost:   Number(r.unit_cost),
      total_value: Number(r.total_value),
    }))

    return res.json({ rows, total: rows.length })
  } catch (err) {
    console.error("[factory-orders/china-inventory/detail]", err)
    return res.status(500).json({ error: "Failed to fetch China inventory detail" })
  }
}
