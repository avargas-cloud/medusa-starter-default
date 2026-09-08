/**
 * GET /admin/reports/expenses/commitments
 *
 * Lo aprobado que todavía no es un documento contable realizado: subcontratos
 * approved/settling sin bill confirmado y comisiones de venta aprobadas sin
 * liquidar. Es una foto de HOY (no admite período: un compromiso no tiene fecha
 * contable hasta que se vuelve bill), informativa, y nunca se suma al P&L ni a
 * Expenses. Definición en `_lib/period-costs.ts`.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

import { fetchPendingCommitments } from "../../_lib/period-costs"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as any
  try {
    const commitments = await fetchPendingCommitments(pg)
    const totalCents = commitments.reduce((s, c) => s + c.amount_cents, 0)
    return res.json({
      as_of: new Date().toISOString(),
      count: commitments.length,
      total: Math.round(totalCents) / 100,
      commitments: commitments.map((c) => ({ ...c, amount: Math.round(c.amount_cents) / 100 })),
    })
  } catch (e: any) {
    return res.status(500).json({ error: e.message })
  }
}
