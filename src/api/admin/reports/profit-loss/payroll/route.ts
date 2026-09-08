/**
 * GET/POST /admin/reports/profit-loss/payroll — costo de nómina mensual manual.
 *
 * Las DOS rutas exigen admin completo (`requireFullAdmin`, el mismo gate que
 * el cierre de mes): un cajero es usuario admin de Medusa y la sección Reports
 * la abre también contabilidad, pero cargar o listar sueldos por mes es del
 * dueño. El POST además verifica el PIN de supervisor EN LA RUTA
 * (`guardSupervisorPin`, con throttle por usuario): el modal sólo recolecta la
 * credencial y la manda en `x-supervisor-pin`. Las dos mitades del gate las
 * afirma `verify-pin-enforcement.ts` (§4b la ruta exige · §4c la pantalla manda).
 *
 * Idempotente: un upsert por mes keyeado por el índice único; cero borra el
 * mes. Se devuelve el estado RELEÍDO, no el payload. Nunca toca QuickBooks.
 * Misma forma que `sales/revenue-baseline`.
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http"
import { randomUUID } from "crypto"

import {
  FullAdminRequiredError,
  requireFullAdmin,
} from "../../../../../lib/accounting/month-close-auth"
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard"
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin"
import { fetchPayrollRows, parsePayrollEntries } from "../../_lib/monthly-payroll"

type Pg = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

async function requireAdmin(req: MedusaRequest, res: MedusaResponse): Promise<boolean> {
  try {
    await requireFullAdmin(req as AuthenticatedMedusaRequest)
    return true
  } catch (error) {
    if (error instanceof FullAdminRequiredError) {
      res.status(error.status).json({ error: "Only a full administrator can manage payroll entries.", code: error.code })
      return false
    }
    throw error
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAdmin(req, res))) return
  const pg = req.scope.resolve("__pg_connection__") as Pg
  try {
    return res.json({ entries: await fetchPayrollRows(pg) })
  } catch {
    return res.status(500).json({ error: "Failed to fetch payroll entries" })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!(await requireAdmin(req, res))) return
  const pg = req.scope.resolve("__pg_connection__") as Pg
  {
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: pg as unknown as PinConn,
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    })
    if (!guard.ok) {
      const { status, body } = pinGuardResponse(guard)
      return res.status(status).json(body)
    }
  }
  const body = (req.body ?? {}) as { entries?: unknown }
  const parsed = parsePayrollEntries(body.entries)
  if (!parsed.ok) return res.status(400).json({ error: parsed.error })

  const actorId = resolveActorId(req)
  const { upserts, deletes } = parsed.value
  try {
    if (deletes.length) {
      await pg.raw(
        `DELETE FROM pos_monthly_payroll WHERE month IN (${deletes.map(() => "?").join(", ")})`,
        deletes
      )
    }
    for (const e of upserts) {
      await pg.raw(
        `INSERT INTO pos_monthly_payroll (id, month, amount_cents, note, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (month) DO UPDATE SET
           amount_cents       = EXCLUDED.amount_cents,
           note               = EXCLUDED.note,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at         = NOW()`,
        [`mpay_${randomUUID()}`, e.month, e.amount_cents, e.note, actorId]
      )
    }
    return res.json({
      entries: await fetchPayrollRows(pg),
      saved: upserts.length,
      removed: deletes.length,
    })
  } catch {
    return res.status(500).json({ error: "Failed to save payroll entries" })
  }
}
