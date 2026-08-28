import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { randomUUID } from "crypto"
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../../lib/pos/supervisor-pin-guard"
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin"
import { parseBaselineEntries } from "../../_lib/revenue-baseline"

/**
 * Baseline manual de revenue por mes — el puente hacia antes del POS.
 *
 * GET  → todas las filas. Es lectura y no pide PIN.
 * POST → upsert por mes. EXIGE PIN de supervisor.
 *
 * El PIN no es ceremonia: acá se escribe a mano un número que después sale en
 * un reporte de ventas, y como en este POS todo cajero es un usuario admin,
 * sin gate cualquier token válido reescribe la historia del año con un POST
 * directo. La verificación va en la RUTA, nunca en la pantalla — el modal
 * recolecta la credencial, no autoriza.
 *
 * Alcance deliberado, y es la mitad importante del diseño: esto lo lee SÓLO el
 * tab Annual. El `Gross Revenue` del Dashboard es la cifra que se concilia
 * contra QuickBooks; si el ajuste manual se filtrara ahí, se rompería el único
 * número cruzable contra el ledger.
 */

type Pg = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
}

interface BaselineRow {
  month: string
  amount_cents: string | number
  note: string | null
  updated_by_user_id: string
  updated_at: string
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const pg = req.scope.resolve("__pg_connection__") as Pg
  try {
    const result = await pg.raw(
      `SELECT month, amount_cents, note, updated_by_user_id, updated_at
       FROM pos_monthly_revenue_baseline
       ORDER BY month`
    )
    return res.json({
      entries: (result.rows as BaselineRow[]).map((r) => ({
        month: r.month,
        // bigint vuelve como string por el driver: un `+` sobre eso concatena.
        amount_cents: Number(r.amount_cents),
        note: r.note,
        updated_by_user_id: r.updated_by_user_id,
        updated_at: r.updated_at,
      })),
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to fetch revenue baseline" })
  }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
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
  const parsed = parseBaselineEntries(body.entries)
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error })
  }

  const actorId = resolveActorId(req)
  const { upserts, deletes } = parsed.value

  try {
    if (deletes.length) {
      await pg.raw(
        `DELETE FROM pos_monthly_revenue_baseline
         WHERE month IN (${deletes.map(() => "?").join(", ")})`,
        deletes
      )
    }

    // Un upsert por mes, keyeado por el índice único: reenviar el mismo payload
    // deja exactamente el mismo estado. La ruta es idempotente por construcción,
    // que es la regla del repo para todo write de dinero.
    for (const e of upserts) {
      await pg.raw(
        `INSERT INTO pos_monthly_revenue_baseline
           (id, month, amount_cents, note, updated_by_user_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (month) DO UPDATE SET
           amount_cents       = EXCLUDED.amount_cents,
           note               = EXCLUDED.note,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at         = NOW()`,
        [`mrb_${randomUUID()}`, e.month, e.amount_cents, e.note, actorId]
      )
    }

    const result = await pg.raw(
      `SELECT month, amount_cents, note, updated_by_user_id, updated_at
       FROM pos_monthly_revenue_baseline
       ORDER BY month`
    )
    return res.json({
      // Se devuelve el estado RELEÍDO, no el payload: así la pantalla dibuja lo
      // que quedó guardado y no lo que creyó mandar.
      entries: (result.rows as BaselineRow[]).map((r) => ({
        month: r.month,
        amount_cents: Number(r.amount_cents),
        note: r.note,
        updated_by_user_id: r.updated_by_user_id,
        updated_at: r.updated_at,
      })),
      saved: upserts.length,
      removed: deletes.length,
    })
  } catch (err) {
    return res.status(500).json({ error: "Failed to save revenue baseline" })
  }
}
