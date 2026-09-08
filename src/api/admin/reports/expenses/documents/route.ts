/**
 * GET /admin/reports/expenses/documents?from&to[&account_list_id=…][&bucket=cost|income|unclassified|balance_sheet|pending_link]
 *
 * Drill-down del reporte Expenses: una fila por línea de cuenta (bill, credit
 * memo de fraude o ajuste de redondeo) con el importe imputado a ESA cuenta.
 * Un bill con líneas en dos cuentas aparece dos veces, una por cuenta; el
 * filtro por `account_list_id` deja sólo la porción de esa cuenta.
 *
 * Misma fuente que `summary` (`_lib/period-costs.ts`); sin paginar — la
 * cardinalidad medida en prod es de decenas de documentos por mes.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { parseDateRange } from "../../_lib/date-range"
import { fetchPeriodCostLines } from "../../_lib/period-costs"

const BUCKETS = new Set(["cost", "income", "unclassified", "balance_sheet", "pending_link"])

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })
  const { account_list_id: accountListId, bucket } = req.query as {
    account_list_id?: string
    bucket?: string
  }
  if (bucket && !BUCKETS.has(bucket)) {
    return res.status(400).json({ error: `bucket must be one of ${[...BUCKETS].join(", ")}` })
  }
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const lines = await fetchPeriodCostLines(pg, range.from, range.to)
    const filtered = lines.filter(
      (l) =>
        (!accountListId || l.account_list_id === accountListId) &&
        (!bucket || l.bucket === bucket)
    )
    return res.json({
      from: range.from,
      to: range.to,
      count: filtered.length,
      documents: filtered.map((l) => ({
        ...l,
        amount: Math.round(l.amount_cents) / 100,
      })),
    })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
}
