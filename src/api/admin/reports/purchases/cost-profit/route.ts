import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { NET_ITEM_REVENUE } from "../../_lib/revenue-expr"

const ROOT_CAT = 'pcat_01KGAD1KQV29RKZZHEZ4N88B8H'

const TIER1_CTE = `
  product_tier1 AS (
    SELECT DISTINCT pcp.product_id,
      COALESCE(
        CASE WHEN pc.parent_category_id = '${ROOT_CAT}' THEN pc.name END,
        CASE WHEN pc2.parent_category_id = '${ROOT_CAT}' THEN pc2.name END,
        'Uncategorized'
      ) AS category
    FROM product_category_product pcp
    JOIN product_category pc ON pc.id = pcp.product_category_id
    LEFT JOIN product_category pc2 ON pc2.id = pc.parent_category_id
  )
`

// pos_invoice.discount already includes ALL discounts (inline item % + promo codes).
// NET_ITEM_REVENUE distributes that total proportionally — do NOT subtract adjustments again.
const NET_REVENUE_EXPR = `(${NET_ITEM_REVENUE})`

const COST_EXPR = `
  CASE WHEN pii.average_unit_cost IS NOT NULL
       THEN ROUND((pii.average_unit_cost * pii.quantity * 100)::numeric, 0)
       ELSE 0 END
`

const BASE_FROM = `
  FROM pos_invoice_item pii
  JOIN pos_invoice i
    ON i.id = pii.invoice_id AND i.deleted_at IS NULL
  LEFT JOIN product_variant pv
    ON pv.id = pii.variant_id AND pv.deleted_at IS NULL
  LEFT JOIN product p
    ON p.id = pv.product_id AND p.deleted_at IS NULL
  LEFT JOIN product_tier1 pt ON pt.product_id = p.id
  WHERE pii.deleted_at IS NULL
    AND i.status IN ('paid', 'partially_refunded')
    AND i.created_at >= ? AND i.created_at < ?
`

const VENDOR_EXPR = `
  CASE WHEN (p.metadata->>'is_sourced_via_agent')::boolean = true
       THEN 'Veetech'
       ELSE COALESCE(NULLIF(TRIM(p.metadata->>'qb_vendor_full_name'), ''), 'Unknown')
  END
`

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [totalsResult, byCatResult, byVendorResult] = await Promise.all([
      pg.raw(
        `WITH ${TIER1_CTE}
         SELECT
           SUM(${NET_REVENUE_EXPR})::bigint                               AS revenue_cents,
           SUM(${COST_EXPR})::bigint                                      AS cost_cents,
           COUNT(*)::int                                                   AS total_items,
           COUNT(CASE WHEN pii.average_unit_cost IS NOT NULL THEN 1 END)::int AS costed_items
         ${BASE_FROM}`,
        [range.from, range.to]
      ),
      pg.raw(
        `WITH ${TIER1_CTE}
         SELECT
           COALESCE(pt.category, 'Uncategorized')    AS label,
           SUM(${NET_REVENUE_EXPR})::bigint           AS revenue_cents,
           SUM(${COST_EXPR})::bigint                  AS cost_cents
         ${BASE_FROM}
         GROUP BY 1
         ORDER BY revenue_cents DESC`,
        [range.from, range.to]
      ),
      pg.raw(
        `WITH ${TIER1_CTE}
         SELECT
           ${VENDOR_EXPR}                             AS label,
           SUM(${NET_REVENUE_EXPR})::bigint           AS revenue_cents,
           SUM(${COST_EXPR})::bigint                  AS cost_cents
         ${BASE_FROM}
         GROUP BY 1
         ORDER BY revenue_cents DESC`,
        [range.from, range.to]
      ),
    ])

    const t = totalsResult.rows[0]
    const revenueCents = Number(t?.revenue_cents ?? 0)
    const costCents    = Number(t?.cost_cents ?? 0)
    const profitCents  = revenueCents - costCents
    const totalItems   = Number(t?.total_items ?? 0)
    const costedItems  = Number(t?.costed_items ?? 0)

    const mapRows = (rows: any[]) =>
      rows.map(r => {
        const rev    = Number(r.revenue_cents) / 100
        const cost   = Number(r.cost_cents) / 100
        const profit = rev - cost
        return {
          label:      r.label as string,
          revenue:    rev,
          cost,
          profit,
          margin_pct: rev > 0 ? Math.round((profit / rev) * 1000) / 10 : 0,
        }
      })

    return res.json({
      totals: {
        revenue:      revenueCents / 100,
        cost:         costCents / 100,
        profit:       profitCents / 100,
        margin_pct:   revenueCents > 0 ? Math.round((profitCents / revenueCents) * 1000) / 10 : 0,
        coverage_pct: totalItems > 0 ? Math.round((costedItems / totalItems) * 1000) / 10 : 0,
      },
      by_category: mapRows(byCatResult.rows),
      by_vendor:   mapRows(byVendorResult.rows),
    })
  } catch (err) {
    console.error("[cost-profit]", err)
    return res.status(500).json({ error: "Failed to fetch cost/profit data" })
  }
}
