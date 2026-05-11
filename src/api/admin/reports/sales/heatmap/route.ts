import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { parseDateRange } from "../../_lib/date-range"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })

  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const result = await pg.raw(
      `WITH weekday_counts AS (
         SELECT
           EXTRACT(DOW FROM gs)::int AS day,
           COUNT(*)::int             AS day_count
         FROM generate_series(?::date, ?::date - interval '1 day', interval '1 day') AS gs
         GROUP BY 1
       )
       SELECT
         EXTRACT(DOW  FROM issued_at AT TIME ZONE 'America/New_York')::int AS day,
         EXTRACT(HOUR FROM issued_at AT TIME ZONE 'America/New_York')::int AS hour,
         SUM(total)::bigint AS revenue,
         COUNT(*)::int      AS invoice_count,
         wc.day_count
       FROM pos_invoice
       JOIN weekday_counts wc
         ON wc.day = EXTRACT(DOW FROM issued_at AT TIME ZONE 'America/New_York')::int
       WHERE deleted_at IS NULL
         AND status NOT IN ('draft','voided')
         AND issued_at >= ? AND issued_at < ?
       GROUP BY 1, 2, wc.day_count
       ORDER BY 1, 2`,
      [range.from, range.to, range.from, range.to]
    )

    const cells = (result.rows as any[]).map((r) => {
      const dayCount = Number(r.day_count) || 1
      return {
        day: Number(r.day),
        hour: Number(r.hour),
        revenue: Number(r.revenue) / 100 / dayCount,
        invoice_count: Number(r.invoice_count) / dayCount,
      }
    })

    return res.json({ cells })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch sales heatmap" })
  }
}
