/**
 * Validación del baseline manual de revenue por mes.
 *
 * Pura y exportada para que `src/__tests__/reports-trend/revenue-baseline.unit.spec.ts`
 * la gatee: es la puerta de entrada de un número TIPEADO A MANO que después
 * sale en un reporte de ventas, así que acá no hay coerción silenciosa. Un
 * payload dudoso se RECHAZA con su motivo — nunca se corrige de oficio.
 *
 * La trampa principal, y la razón de que `amount_cents` exija un entero: si
 * alguien manda dólares (431.62) creyendo que manda centavos, un `Math.round`
 * amable guardaría $4,32 y el gráfico mostraría una barra plausible pero cien
 * veces chica. Un 400 explicando la unidad se arregla en un minuto; un número
 * mal guardado se descubre en el cierre del mes.
 */

export interface ParsedBaselineEntry {
  month: string
  amount_cents: number
  note: string | null
}

export interface ParsedBaseline {
  /** Meses con monto: se insertan o se pisan. */
  upserts: ParsedBaselineEntry[]
  /** Meses que llegaron en 0: el ajuste se retira. */
  deletes: string[]
}

export type ParseResult =
  | { ok: true; value: ParsedBaseline }
  | { ok: false; error: string }

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Un siglo de meses. Un payload más grande que esto es un cliente roto, no un uso. */
const MAX_ENTRIES = 1200

/** $10.000.000 en centavos. Tope de cordura para un monto tipeado a mano. */
const MAX_ABS_CENTS = 1_000_000_000

const MAX_NOTE_LENGTH = 500

export function parseBaselineEntries(raw: unknown): ParseResult {
  if (!Array.isArray(raw)) {
    return { ok: false, error: "entries must be an array" }
  }
  if (raw.length > MAX_ENTRIES) {
    return { ok: false, error: `entries must hold at most ${MAX_ENTRIES} months` }
  }

  const upserts: ParsedBaselineEntry[] = []
  const deletes: string[] = []
  const seen = new Set<string>()

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "each entry must be an object" }
    }
    const { month, amount_cents, note } = item as {
      month?: unknown
      amount_cents?: unknown
      note?: unknown
    }

    if (typeof month !== "string" || !MONTH_RE.test(month)) {
      return { ok: false, error: `month must look like "YYYY-MM" (got ${JSON.stringify(month)})` }
    }
    // Un mes repetido en el mismo payload es una suma que nadie puede auditar:
    // elegir uno en silencio guardaría un número que el operador no escribió.
    if (seen.has(month)) {
      return { ok: false, error: `month ${month} appears more than once` }
    }
    seen.add(month)

    if (typeof amount_cents !== "number" || !Number.isInteger(amount_cents)) {
      return {
        ok: false,
        error: `amount_cents for ${month} must be an integer number of CENTS (got ${JSON.stringify(amount_cents)})`,
      }
    }
    if (Math.abs(amount_cents) > MAX_ABS_CENTS) {
      return { ok: false, error: `amount_cents for ${month} is out of range` }
    }

    if (amount_cents === 0) {
      // Cero no es un ajuste de cero: es "sacá el ajuste". Guardar la fila
      // dejaría un renglón de auditoría que dice que alguien sumó nada.
      deletes.push(month)
      continue
    }

    if (note !== undefined && note !== null && typeof note !== "string") {
      return { ok: false, error: `note for ${month} must be a string` }
    }
    const trimmed = typeof note === "string" ? note.trim() : ""
    if (trimmed.length > MAX_NOTE_LENGTH) {
      return { ok: false, error: `note for ${month} must be at most ${MAX_NOTE_LENGTH} characters` }
    }

    upserts.push({ month, amount_cents, note: trimmed === "" ? null : trimmed })
  }

  return { ok: true, value: { upserts, deletes } }
}
