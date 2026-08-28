import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { autoBucket, bucketLabel, bucketTrunc, parseBucket } from "../../_lib/auto-bucket"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"
import {
  NET_ITEM_REVENUE,
  SALES_ACTIVE_STATUSES_SQL,
  SALES_DATE_FILTER_SQL,
} from "../../_lib/sales-revenue"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const bucket = autoBucket(range, parseBucket((req.query as { bucket?: string }).bucket))
  const etIssuedAt = "i.issued_at AT TIME ZONE 'America/New_York'"
  const trunc = bucketTrunc(bucket, etIssuedAt)
  const label = bucketLabel(bucket, etIssuedAt)
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
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
    )

    const points = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      const margin = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0
      return {
        label: String(r.bucket),
        revenue,
        profit,
        margin,
      }
    })

    return res.json({ bucket, points })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales trend" })
  }
}
