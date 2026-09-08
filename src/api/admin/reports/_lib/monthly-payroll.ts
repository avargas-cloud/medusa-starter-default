/**
 * monthly-payroll.ts — costo de nómina mensual cargado a mano, para la sección
 * Expense del Profit & Loss.
 *
 * ## Por qué manual y por qué acá
 *
 * Los salarios no pasan por el POS: no hay bill, no hay documento, no hay
 * cuenta de QuickBooks que sincronizar. Sin ellos el P&L sobreestima la
 * utilidad. Un admin completo carga UN monto por mes (costo total de nómina)
 * con PIN de supervisor verificado en la ruta, y este módulo lo reconoce en el
 * período que se está mirando. Nunca viaja a QuickBooks.
 *
 * ## Reconocimiento bisemanal (decisión del owner, 2026-09-08)
 *
 * La nómina se paga dos veces al mes: la mitad el día 15 y la otra mitad el
 * día 30 (o el último día si el mes es más corto: febrero). El mes se carga
 * ENTERO, el día que sea — aunque sea el 1 — y este módulo lo parte solo. Un
 * período reconoce las mitades cuyas fechas de pago (medianoche ET de ese día)
 * caen dentro de [from, to):
 *
 *   · un mes entero suma exacto;
 *   · del 1 al 14 suma cero; del 1 al 15 suma la mitad;
 *   · el centavo impar va a la segunda mitad, así las dos suman el total.
 *
 * Se computa en JS con `etMidnightUtc` (la tabla es chica, decenas de filas):
 * la fecha de pago es un día de calendario de negocio, no un instante UTC.
 *
 * Bindings knex `?`.
 */
import { etMidnightUtc } from "../../../../lib/date/et"

type RawPg = {
  raw: (sql: string, bindings: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

export const PAYROLL_LINE_KEY = "payroll"
export const PAYROLL_LINE_LABEL = "Payroll cost (manual monthly entry)"

const MONTH_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/

export interface PayrollRow {
  month: string
  amount_cents: number
  note: string | null
  updated_by_user_id: string
  updated_at: string
}

export interface ParsedPayrollEntry {
  month: string
  amount_cents: number
  note: string | null
}

export type ParsedPayroll = { upserts: ParsedPayrollEntry[]; deletes: string[] }
export type PayrollParseResult = { ok: true; value: ParsedPayroll } | { ok: false; error: string }

/**
 * Valida el payload del POST. Centavos ENTEROS ≥ 0; cero = borrar el mes.
 * Un mes repetido en el mismo payload es un error, no "el último gana".
 */
export function parsePayrollEntries(raw: unknown): PayrollParseResult {
  if (!Array.isArray(raw)) return { ok: false, error: "entries must be an array" }
  const upserts: ParsedPayrollEntry[] = []
  const deletes: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, error: "each entry must be an object" }
    const e = item as { month?: unknown; amount_cents?: unknown; note?: unknown }
    if (typeof e.month !== "string" || !MONTH_RE.test(e.month)) {
      return { ok: false, error: `invalid month: ${String(e.month)} (expected YYYY-MM)` }
    }
    if (seen.has(e.month)) return { ok: false, error: `duplicate month: ${e.month}` }
    seen.add(e.month)
    if (typeof e.amount_cents !== "number" || !Number.isInteger(e.amount_cents) || e.amount_cents < 0) {
      return { ok: false, error: `amount_cents must be a non-negative integer (month ${e.month})` }
    }
    const note = typeof e.note === "string" && e.note.trim() ? e.note.trim().slice(0, 500) : null
    if (e.amount_cents === 0) deletes.push(e.month)
    else upserts.push({ month: e.month, amount_cents: e.amount_cents, note })
  }
  return { ok: true, value: { upserts, deletes } }
}

/** Día del segundo pago: el 30, o el último día si el mes no llega (febrero). */
export const SECOND_PAY_DAY = 30

/** Las dos fechas de pago del mes (medianoche ET) con la mitad que reconoce cada una. Puro. */
export function payrollHalves(month: string, amountCents: number): Array<{ at: Date; cents: number }> {
  const y = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7)) - 1
  const lastDay = new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate()
  const first = Math.floor(amountCents / 2)
  return [
    { at: etMidnightUtc(y, monthIndex, 15), cents: first },
    { at: etMidnightUtc(y, monthIndex, Math.min(SECOND_PAY_DAY, lastDay)), cents: amountCents - first },
  ]
}

/** Centavos de nómina reconocidos en [from, to). Puro. */
export function recognizedPayrollCents(
  rows: readonly { month: string; amount_cents: number }[],
  from: string,
  to: string
): number {
  const f = new Date(from).getTime()
  const t = new Date(to).getTime()
  let total = 0
  for (const r of rows) {
    for (const h of payrollHalves(r.month, Number(r.amount_cents))) {
      const at = h.at.getTime()
      if (at >= f && at < t) total += h.cents
    }
  }
  return total
}

export async function fetchPayrollRows(pg: RawPg): Promise<PayrollRow[]> {
  const result = await pg.raw(
    `SELECT month, amount_cents, note, updated_by_user_id, updated_at
       FROM pos_monthly_payroll
      ORDER BY month`,
    []
  )
  return result.rows.map((r) => ({
    month: String(r.month),
    amount_cents: Number(r.amount_cents),
    note: r.note == null ? null : String(r.note),
    updated_by_user_id: String(r.updated_by_user_id),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  }))
}

export async function fetchRecognizedPayrollCents(pg: RawPg, from: string, to: string): Promise<number> {
  return recognizedPayrollCents(await fetchPayrollRows(pg), from, to)
}
