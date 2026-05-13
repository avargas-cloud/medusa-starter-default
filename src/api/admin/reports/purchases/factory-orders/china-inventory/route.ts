import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'
const ROOT_CAT   = 'pcat_01KGAD1KQV29RKZZHEZ4N88B8H'

const REPORT_CTES = `
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
  ),
  active_transfer AS (
    SELECT
      itl.product_variant_id,
      SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0)))::numeric AS qty_pending
    FROM inventory_transfer it
    JOIN inventory_transfer_line itl
      ON itl.transfer_id = it.id
     AND itl.deleted_at IS NULL
    JOIN purchase_order po
      ON po.id = it.linked_purchase_order_id
     AND po.deleted_at IS NULL
    WHERE it.deleted_at IS NULL
      AND it.origin_country = 'CN'
      AND it.status IN ('confirmed', 'shipped')
      AND EXISTS (
        SELECT 1
        FROM china_finance_bill cfb
        WHERE cfb.po_number = po.qb_purchase_order_txn_number
           OR cfb.po_ref_number = po.number
           OR cfb.vendor_bill_id IN (
            SELECT vb.id
            FROM vendor_bill vb
            WHERE vb.purchase_order_id = po.id
              AND vb.deleted_at IS NULL
          )
      )
    GROUP BY itl.product_variant_id
  )
`

const UNIT_COST = `COALESCE(
  (pv.metadata->>'average_unit_cost')::numeric,
  (pv.metadata->>'qb_avg_cost')::numeric,
  0
)`

const CHINA_AVAILABLE_QTY = `GREATEST(
  0,
  il.stocked_quantity - COALESCE(atq.qty_pending, 0)
)`

const BASE_JOINS = `
  FROM inventory_level il
  JOIN inventory_item ii ON ii.id = il.inventory_item_id
  JOIN product_variant_inventory_item pvii ON pvii.inventory_item_id = ii.id
  JOIN product_variant pv ON pv.id = pvii.variant_id AND pv.deleted_at IS NULL
  JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
  LEFT JOIN tier1 t1 ON t1.product_id = p.id
  LEFT JOIN active_transfer atq ON atq.product_variant_id = pv.id
  WHERE il.location_id = '${CHINA_SLOC}' AND il.stocked_quantity > 0
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [byFactoryRes, byCategoryRes] = await Promise.all([
      pg.raw(
        `WITH ${REPORT_CTES}
         SELECT
           COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'),''), 'Unknown') AS label,
           COUNT(DISTINCT pv.id)::int                                                AS variants,
           SUM(${CHINA_AVAILABLE_QTY})::int                                          AS qty,
           ROUND(SUM(${CHINA_AVAILABLE_QTY} * ${UNIT_COST})::numeric, 2)             AS value
         ${BASE_JOINS}
         GROUP BY 1
         HAVING SUM(${CHINA_AVAILABLE_QTY}) > 0
         ORDER BY value DESC, qty DESC`
      ),
      pg.raw(
        `WITH ${REPORT_CTES}
         SELECT
           COALESCE(t1.category, 'Uncategorized')                                   AS label,
           COUNT(DISTINCT pv.id)::int                                                AS variants,
           SUM(${CHINA_AVAILABLE_QTY})::int                                          AS qty,
           ROUND(SUM(${CHINA_AVAILABLE_QTY} * ${UNIT_COST})::numeric, 2)             AS value
         ${BASE_JOINS}
         GROUP BY 1
         HAVING SUM(${CHINA_AVAILABLE_QTY}) > 0
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
