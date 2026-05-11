import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [kpisResult, vendorsResult] = await Promise.all([
      pg.raw(
        `SELECT
           COUNT(DISTINCT po.id)::int                                                              AS total_pos,
           COUNT(DISTINCT CASE WHEN po.status IN ('submitted','partially_received') THEN po.id END)::int AS open_pos,
           COUNT(DISTINCT CASE WHEN po.status = 'received' THEN po.id END)::int                        AS received_pos,
           COUNT(DISTINCT po.vendor_id)::int                                                       AS vendors,
           COALESCE(SUM(pol.total_cents), 0)::bigint                                               AS total_ordered_cents,
           COALESCE(SUM(pol.unit_cost_cents * pol.qty_received), 0)::bigint                        AS total_received_cents,
           COALESCE(SUM(CASE WHEN (p.metadata->>'is_sourced_via_agent')::boolean = true
                             THEN pol.total_cents ELSE 0 END), 0)::bigint                          AS china_ordered_cents,
           COALESCE(SUM(CASE WHEN (p.metadata->>'is_sourced_via_agent')::boolean IS NOT TRUE
                             THEN pol.total_cents ELSE 0 END), 0)::bigint                          AS usa_ordered_cents
         FROM purchase_order po
         JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
         LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
         LEFT JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
         WHERE po.deleted_at IS NULL AND po.status NOT IN ('voided','cancelled')
           AND COALESCE(po.ordered_at, po.created_at) >= ? AND COALESCE(po.ordered_at, po.created_at) < ?`,
        [range.from, range.to]
      ),
      pg.raw(
        `SELECT
           po.vendor_name_snapshot                AS vendor,
           COUNT(DISTINCT po.id)::int             AS po_count,
           SUM(pol.qty_ordered)::int              AS units_ordered,
           SUM(pol.qty_received)::int             AS units_received,
           SUM(pol.total_cents)::bigint           AS total_cents
         FROM purchase_order po
         JOIN purchase_order_line pol ON pol.purchase_order_id = po.id AND pol.deleted_at IS NULL
         WHERE po.deleted_at IS NULL AND po.status NOT IN ('voided','cancelled')
           AND COALESCE(po.ordered_at, po.created_at) >= ? AND COALESCE(po.ordered_at, po.created_at) < ?
         GROUP BY 1
         ORDER BY total_cents DESC`,
        [range.from, range.to]
      ),
    ])

    const k = kpisResult.rows[0]
    return res.json({
      kpis: {
        total_pos:             Number(k.total_pos),
        open_pos:              Number(k.open_pos),
        received_pos:          Number(k.received_pos),
        vendors:               Number(k.vendors),
        total_ordered:         Number(k.total_ordered_cents) / 100,
        total_received:        Number(k.total_received_cents) / 100,
        china_ordered:         Number(k.china_ordered_cents) / 100,
        usa_ordered:           Number(k.usa_ordered_cents) / 100,
      },
      vendors: (vendorsResult.rows as any[]).map(r => ({
        vendor:          r.vendor as string,
        po_count:        Number(r.po_count),
        units_ordered:   Number(r.units_ordered),
        units_received:  Number(r.units_received),
        total:           Number(r.total_cents) / 100,
      })),
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch purchases summary" })
  }
}
