import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

const CHINA_SLOC = 'sloc_01KQ14C1CFX30EDD722BF87HDM'
const ROOT_CAT   = 'pcat_01KGAD1KQV29RKZZHEZ4N88B8H'
const CHINA_AVAILABLE_QTY = `GREATEST(
  0,
  il.stocked_quantity - COALESCE(atq.qty_pending, 0)
)`

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
       SELECT
         pv.id                                                                    AS variant_id,
         COALESCE(NULLIF(pv.sku,''), ii.sku)                                     AS sku,
         p.title                                                                  AS description,
         COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'),''), 'Unknown') AS factory,
         COALESCE(t1.category, 'Uncategorized')                                  AS category,
         ${CHINA_AVAILABLE_QTY}::int                                              AS qty,
         COALESCE(
           (pv.metadata->>'average_unit_cost')::numeric,
           (pv.metadata->>'qb_avg_cost')::numeric,
           0
         )                                                                        AS unit_cost,
         ROUND(${CHINA_AVAILABLE_QTY} * COALESCE(
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
       LEFT JOIN active_transfer atq ON atq.product_variant_id = pv.id
       WHERE il.location_id = '${CHINA_SLOC}' AND ${CHINA_AVAILABLE_QTY} > 0
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
