/**
 * GET /admin/reports/profit-loss/statement?from&to
 *
 * Profit & Loss del POS con la estructura de QuickBooks, período actual y
 * ventana espejo anterior. Todo el ensamblado vive en `_lib/pnl-statement.ts`;
 * la ruta sólo parsea el rango y devuelve dólares.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { parseDateRange, priorPeriod } from "../../_lib/date-range"
import { buildPnlStatementForRange } from "../../_lib/pnl-statement"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const range = parseDateRange(req)
  if (!range) return res.status(400).json({ error: "from and to are required" })
  const prior = priorPeriod(range)
  const pg = req.scope.resolve("__pg_connection__") as any

  try {
    const [current, previous] = await Promise.all([
      buildPnlStatementForRange(pg, range),
      buildPnlStatementForRange(pg, prior),
    ])
    return res.json({ current, prior: previous })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
}
