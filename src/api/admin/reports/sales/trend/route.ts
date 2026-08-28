import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { autoBucket, bucketLabel, bucketTrunc, parseBucket } from "../../_lib/auto-bucket"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import {
  CM_REFUND_CENTS_EXPR,
  CM_REFUND_DATE_COL,
  CM_REFUND_SCOPE_SQL,
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
} from "../../_lib/sales-revenue"
import { mergeTrendPoints, type RefundRow, type SalesRow } from "../../_lib/trend-points"

/**
 * Revenue / gross profit / margin per time bucket.
 *
 * `revenue` is NET — billed minus returns — and profit and margin are derived
 * from it. That is not a preference, it is the definition the summary endpoint
 * on the same screen already documents:
 *
 *   net_revenue  = gross_revenue − returns
 *   gross_profit = net_revenue − COGS      ← NET, not gross
 *   margin_pct   = gross_profit / net_revenue
 *
 * This endpoint used to skip returns entirely, so the chart plotted gross while
 * the KPI tiles three centimetres above it plotted net, and the "Gross Profit"
 * line was overstated by the full refund amount on top of that. Measured on
 * production 2026-08-28: $18,435.24 of completed credit memos year-to-date
 * across 131 memos, every month — 3.6% of revenue, and never an edge case.
 *
 * Returns arrive in their OWN query rather than a join. A credit memo has no
 * row in pos_invoice_item, and joining it into the revenue aggregate would
 * either fan out the line-level sum or drop the months whose only activity was
 * a return. Both queries emit the same bucket label, and the merge is a union
 * of labels — so a month with returns and no sales still draws, with negative
 * revenue, which is what actually happened.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const bucket = autoBucket(range, parseBucket((req.query as { bucket?: string }).bucket))
  const etIssuedAt = "i.issued_at AT TIME ZONE 'America/New_York'"
  const etRefundedAt = `${CM_REFUND_DATE_COL} AT TIME ZONE 'America/New_York'`
  const trunc = bucketTrunc(bucket, etIssuedAt)
  const label = bucketLabel(bucket, etIssuedAt)
  const refundTrunc = bucketTrunc(bucket, etRefundedAt)
  const refundLabel = bucketLabel(bucket, etRefundedAt)
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [sales, refunds] = await Promise.all([
      pg.raw(
        `SELECT
           ${label}                              AS bucket,
           SUM(${NET_ITEM_REVENUE})::bigint     AS revenue,
           SUM(${COST_DOLLARS})::bigint           AS cogs
         FROM pos_invoice i
         JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
         ${COGS_JOIN}
         WHERE i.deleted_at IS NULL
           AND ${SALES_ACTIVE_STATUSES_SQL}
           AND ${SALES_DATE_FILTER_SQL}
         GROUP BY ${trunc}
         ORDER BY ${trunc}`,
        [range.from, range.to]
      ),
      pg.raw(
        `SELECT
           ${refundLabel}                        AS bucket,
           SUM(${CM_REFUND_CENTS_EXPR})::bigint  AS refund_cents
         FROM pos_credit_memo cm
         WHERE ${CM_REFUND_SCOPE_SQL}
           AND ${CM_REFUND_DATE_COL} >= ?
           AND ${CM_REFUND_DATE_COL} <  ?
         GROUP BY ${refundTrunc}
         ORDER BY ${refundTrunc}`,
        [range.from, range.to]
      ),
    ])

    // The merge is unit-gated in `_lib/trend-points.ts` — it is money, and the
    // bug this endpoint shipped with lived in exactly these few lines.
    const points = mergeTrendPoints(sales.rows as SalesRow[], refunds.rows as RefundRow[])

    return res.json({ bucket, points })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales trend" })
  }
}
