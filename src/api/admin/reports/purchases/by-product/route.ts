import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"

const CHINA_FILTER = `AND (p.metadata->>'is_sourced_via_agent')::boolean = true`
const USA_FILTER   = `AND ((p.metadata->>'is_sourced_via_agent')::boolean IS NOT TRUE OR p.id IS NULL)`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const region = (req.query.region as string) ?? "all"
  const regionFilter = region === "china" ? CHINA_FILTER : region === "usa" ? USA_FILTER : ""

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH vb_costs AS (
         SELECT
           vbl.product_variant_id,
           vb.purchase_order_id,
           SUM(vbl.commission_per_unit_cents * vbl.qty) AS commission_cents,
           SUM(vbl.freight_per_unit_cents   * vbl.qty) AS freight_cents,
           SUM(vbl.tariff_per_unit_cents    * vbl.qty) AS tariff_cents,
           SUM(vbl.landed_unit_cost_cents   * vbl.qty) AS landed_cents,
           true                                         AS has_bill
         FROM vendor_bill vb
         JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id
           AND vbl.line_type = 'product' AND vbl.deleted_at IS NULL
         WHERE vb.status = 'confirmed' AND vb.deleted_at IS NULL
         GROUP BY vbl.product_variant_id, vb.purchase_order_id
       ),
       product_cat AS (
         SELECT pcp.product_id, MIN(pc.name) AS cat_name
         FROM product_category_product pcp
         JOIN product_category pc ON pc.id = pcp.product_category_id
         GROUP BY pcp.product_id
       )
       SELECT
         pol.sku_snapshot                                                          AS sku,
         pol.description_snapshot                                                  AS description,
         po.vendor_name_snapshot                                                   AS vendor,
         COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'), ''), po.vendor_name_snapshot, 'Unknown') AS factory,
         COALESCE(pcat.cat_name, 'Uncategorized')                                  AS category,
         SUM(pol.qty_ordered)::int                                                 AS qty_ordered,
         SUM(pol.qty_received)::int                                                AS qty_received,
         ROUND((AVG(pol.unit_cost_cents) / 100.0)::numeric, 2)                    AS avg_unit_cost,
         SUM(pol.total_cents)::bigint                                              AS product_cost_cents,
         COALESCE(SUM(vbc.commission_cents), 0)::bigint                           AS service_cents,
         COALESCE(SUM(vbc.freight_cents),    0)::bigint                           AS shipping_cents,
         COALESCE(SUM(vbc.tariff_cents),     0)::bigint                           AS tariff_cents,
         COALESCE(SUM(vbc.landed_cents),     0)::bigint                           AS landed_cents,
         BOOL_OR(vbc.has_bill IS NOT NULL)                                        AS has_vendor_bill
       FROM purchase_order po
       JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
       LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
       LEFT JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
       LEFT JOIN product_cat pcat ON pcat.product_id = p.id
       LEFT JOIN vb_costs vbc ON vbc.product_variant_id = pol.product_variant_id
         AND vbc.purchase_order_id = po.id
       WHERE po.deleted_at IS NULL AND po.status NOT IN ('voided','cancelled')
         AND COALESCE(po.ordered_at, po.created_at) >= ? AND COALESCE(po.ordered_at, po.created_at) < ?
         ${regionFilter}
       GROUP BY pol.sku_snapshot, pol.description_snapshot, po.vendor_name_snapshot,
                p.metadata->>'qb_vendor_full_name', pcat.cat_name
       ORDER BY product_cost_cents DESC`,
      [range.from, range.to]
    )

    const rows = (result.rows as any[]).map(r => ({
      sku:              r.sku as string,
      description:      r.description as string,
      vendor:           r.vendor as string,
      factory:          r.factory as string,
      category:         r.category as string,
      qty_ordered:      Number(r.qty_ordered),
      qty_received:     Number(r.qty_received),
      avg_unit_cost:    Number(r.avg_unit_cost),
      product_cost:     Number(r.product_cost_cents) / 100,
      service:          Number(r.service_cents) / 100,
      shipping:         Number(r.shipping_cents) / 100,
      tariff:           Number(r.tariff_cents) / 100,
      landed:           Number(r.landed_cents) / 100,
      has_vendor_bill:  r.has_vendor_bill as boolean,
    }))

    return res.json({ rows })
  } catch (err) {
    console.error("[by-product]", err)
    return res.status(500).json({ error: "Failed to fetch purchases by product" })
  }
}
