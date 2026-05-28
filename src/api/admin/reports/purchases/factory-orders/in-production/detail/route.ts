import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { TIER1_CTE } from "../../../../_lib/category-tier1"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH RECURSIVE ${TIER1_CTE}
       SELECT
         fo.number                                                                  AS fo_number,
         COALESCE(NULLIF(TRIM(fo.metadata->>'manufacturer_vendor_short_name'),''), fo.vendor_name_snapshot) AS factory,
         fo.status                                                                  AS fo_status,
         fol.sku_snapshot                                                           AS sku,
         fol.description_snapshot                                                   AS description,
         COALESCE(t1.category, 'Uncategorized')                                    AS category,
         fol.qty_ordered::int,
         fol.qty_received::int,
         GREATEST(fol.qty_ordered - fol.qty_received - COALESCE(fol.qty_cancelled,0), 0)::int AS qty_pending,
         ROUND(fol.unit_cost_cents / 100.0::numeric, 2)                            AS unit_cost,
         ROUND(
           GREATEST(fol.qty_ordered - fol.qty_received - COALESCE(fol.qty_cancelled,0), 0)
           * fol.unit_cost_cents / 100.0::numeric, 2
         )                                                                          AS total_value
       FROM factory_order fo
       JOIN factory_order_line fol
         ON fol.factory_order_id = fo.id AND fol.deleted_at IS NULL AND fol.status != 'cancelled'
       LEFT JOIN product_variant pv ON pv.id = fol.product_variant_id AND pv.deleted_at IS NULL
       LEFT JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       LEFT JOIN product_tier1 t1 ON t1.product_id = p.id
       WHERE fo.deleted_at IS NULL AND fo.status IN ('submitted','partially_received')
         AND GREATEST(fol.qty_ordered - fol.qty_received - COALESCE(fol.qty_cancelled,0), 0) > 0
       ORDER BY total_value DESC, fo.number, fol.sku_snapshot`
    )

    const rows = (result.rows as any[]).map(r => ({
      fo_number:    r.fo_number as string,
      factory:      r.factory as string,
      fo_status:    r.fo_status as string,
      sku:          r.sku as string,
      description:  r.description as string,
      category:     r.category as string,
      qty_ordered:  Number(r.qty_ordered),
      qty_received: Number(r.qty_received),
      qty_pending:  Number(r.qty_pending),
      unit_cost:    Number(r.unit_cost),
      total_value:  Number(r.total_value),
    }))

    return res.json({ rows, total: rows.length })
  } catch (err) {
    console.error("[factory-orders/in-production/detail]", err)
    return res.status(500).json({ error: "Failed to fetch in-production detail" })
  }
}
