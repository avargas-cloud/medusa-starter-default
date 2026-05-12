import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'
const ROOT_CAT   = 'pcat_01KGAD1KQV29RKZZHEZ4N88B8H'

const TIER1_CTE = `
  tier1 AS (
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
`

const UNIT_COST = `COALESCE(
  (pv.metadata->>'average_unit_cost')::numeric,
  (pv.metadata->>'qb_avg_cost')::numeric,
  0
)`

const BASE_JOINS = `
  FROM inventory_level il
  JOIN inventory_item ii ON ii.id = il.inventory_item_id
  JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
  LEFT JOIN tier1 t1 ON t1.product_id = p.id
  WHERE il.location_id = '${CHINA_SLOC}' AND il.stocked_quantity > 0
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [byFactoryRes, byCategoryRes] = await Promise.all([
      pg.raw(
        `WITH ${TIER1_CTE}
         SELECT
           COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'),''), 'Unknown') AS label,
           COUNT(DISTINCT pv.id)::int                                                AS variants,
           SUM(il.stocked_quantity)::int                                             AS qty,
           ROUND(SUM(il.stocked_quantity * ${UNIT_COST})::numeric, 2)               AS value
         ${BASE_JOINS}
         GROUP BY 1
         ORDER BY value DESC, qty DESC`
      ),
      pg.raw(
        `WITH ${TIER1_CTE}
         SELECT
           COALESCE(t1.category, 'Uncategorized')                                   AS label,
           COUNT(DISTINCT pv.id)::int                                                AS variants,
           SUM(il.stocked_quantity)::int                                             AS qty,
           ROUND(SUM(il.stocked_quantity * ${UNIT_COST})::numeric, 2)               AS value
         ${BASE_JOINS}
         GROUP BY 1
         ORDER BY value DESC, qty DESC`
      ),
    ])

    const mapRow = (r: any) => ({
      label:    r.label as string,
      variants: Number(r.variants),
      qty:      Number(r.qty),
      value:    Number(r.value),
    })

    const allRows = (byFactoryRes.rows as any[]).map(mapRow)
    const totalQty   = allRows.reduce((s, r) => s + r.qty, 0)
    const totalValue = allRows.reduce((s, r) => s + r.value, 0)

    return res.json({
      by_factory:  allRows,
      by_category: (byCategoryRes.rows as any[]).map(mapRow),
      totals: { variants: allRows.length, qty: totalQty, value: Math.round(totalValue * 100) / 100 },
    })
  } catch (err) {
    console.error("[factory-orders/china-inventory]", err)
    return res.status(500).json({ error: "Failed to fetch China inventory" })
  }
}
