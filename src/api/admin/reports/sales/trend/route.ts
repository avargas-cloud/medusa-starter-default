import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"
import { autoBucket, bucketTrunc } from "../../_lib/auto-bucket"
import { COGS_JOIN, COST_DOLLARS } from "../../_lib/cogs-join"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const bucket = autoBucket(range)
  const trunc = bucketTrunc(bucket, "i.issued_at AT TIME ZONE 'America/New_York'")
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `SELECT
         ${trunc}                              AS bucket,
         SUM(pii.total)::bigint               AS revenue,
         SUM(${COST_DOLLARS})::bigint           AS cogs
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
       ${COGS_JOIN}
       WHERE i.deleted_at IS NULL
         AND i.status NOT IN ('draft','voided')
         AND i.issued_at >= ? AND i.issued_at < ?
       GROUP BY 1
       ORDER BY 1`,
      [range.from, range.to]
    )

    const points = (result.rows as any[]).map((r) => {
      const revenue = Number(r.revenue) / 100
      const cogs    = Number(r.cogs)
      const profit  = revenue - cogs
      const margin = revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : 0
      return {
        label: bucket === "day"
          ? String(r.bucket).slice(0, 10)
          : String(r.bucket).slice(0, 7),
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
