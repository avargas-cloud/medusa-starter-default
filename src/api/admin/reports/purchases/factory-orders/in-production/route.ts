import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { avgCostDollars } from "../../../../../../lib/cost/cost-sql"
import { TIER1_CTE } from "../../../_lib/category-tier1"

const PENDING = `GREATEST(fol.qty_ordered - fol.qty_received - COALESCE(fol.qty_cancelled,0), 0)`

const BASE_FROM = `
  FROM factory_order fo
  JOIN factory_order_line fol
    ON fol.factory_order_id = fo.id AND fol.deleted_at IS NULL AND fol.status != 'cancelled'
  LEFT JOIN product_variant pv ON pv.id = fol.product_variant_id AND pv.deleted_at IS NULL
  LEFT JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
  LEFT JOIN product_tier1 t1 ON t1.product_id = p.id
  WHERE fo.deleted_at IS NULL AND fo.status IN ('submitted','partially_received')
    AND ${PENDING} > 0
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [byFactoryRes, byCategoryRes] = await Promise.all([
      pg.raw(
        `WITH RECURSIVE ${TIER1_CTE}
         SELECT
           COALESCE(NULLIF(TRIM(fo.metadata->>'manufacturer_vendor_short_name'),''), fo.vendor_name_snapshot) AS label,
           COUNT(DISTINCT fo.id)::int                                           AS order_count,
           COUNT(DISTINCT fol.product_variant_id)::int                         AS variants,
           SUM(fol.qty_ordered)::int                                            AS qty_ordered,
           SUM(fol.qty_received)::int                                           AS qty_received,
           SUM(${PENDING})::int                                                 AS qty_pending,
           ROUND(SUM(${PENDING} * fol.unit_cost_cents / 100.0)::numeric, 2)    AS value,
           ROUND(SUM(${PENDING} * COALESCE(${avgCostDollars("pv")}, 0))::numeric, 2) AS landed_value
         ${BASE_FROM}
         GROUP BY 1
         ORDER BY value DESC`
      ),
      pg.raw(
        `WITH RECURSIVE ${TIER1_CTE}
         SELECT
           COALESCE(t1.category, 'Uncategorized')                              AS label,
           COUNT(DISTINCT fo.id)::int                                           AS order_count,
           COUNT(DISTINCT fol.product_variant_id)::int                         AS variants,
           SUM(fol.qty_ordered)::int                                            AS qty_ordered,
           SUM(fol.qty_received)::int                                           AS qty_received,
           SUM(${PENDING})::int                                                 AS qty_pending,
           ROUND(SUM(${PENDING} * fol.unit_cost_cents / 100.0)::numeric, 2)    AS value,
           ROUND(SUM(${PENDING} * COALESCE(${avgCostDollars("pv")}, 0))::numeric, 2) AS landed_value
         ${BASE_FROM}
         GROUP BY 1
         ORDER BY value DESC`
      ),
    ])

    const mapRow = (r: any) => ({
      label:        r.label as string,
      order_count:  Number(r.order_count),
      variants:     Number(r.variants),
      qty_ordered:  Number(r.qty_ordered),
      qty_received: Number(r.qty_received),
      qty_pending:  Number(r.qty_pending),
      value:        Number(r.value),
      landed_value: Number(r.landed_value),
    })

    const factoryRows = (byFactoryRes.rows as any[]).map(mapRow)
    const totalPending      = factoryRows.reduce((s, r) => s + r.qty_pending, 0)
    const totalValue        = factoryRows.reduce((s, r) => s + r.value, 0)
    const totalLandedValue  = factoryRows.reduce((s, r) => s + r.landed_value, 0)
    const totalOrders       = factoryRows.reduce((s, r) => s + r.order_count, 0)

    return res.json({
      by_factory:  factoryRows,
      by_category: (byCategoryRes.rows as any[]).map(mapRow),
      totals: {
        order_count:  totalOrders,
        qty_pending:  totalPending,
        value:        Math.round(totalValue * 100) / 100,
        landed_value: Math.round(totalLandedValue * 100) / 100,
      },
    })
  } catch (err) {
    console.error("[factory-orders/in-production]", err)
    return res.status(500).json({ error: "Failed to fetch in-production data" })
  }
}
