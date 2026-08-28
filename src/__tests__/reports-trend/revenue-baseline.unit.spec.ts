/**
 * parseBaselineEntries — la puerta de entrada del baseline manual.
 *
 * Es el único punto donde un número TIPEADO A MANO entra a un reporte de
 * ventas. Todo lo que pase de acá se guarda y se muestra como si fuera dato,
 * así que la regla es rechazar con motivo, nunca corregir de oficio.
 */
import { parseBaselineEntries } from "../../api/admin/reports/_lib/revenue-baseline"

function ok(raw: unknown) {
  const r = parseBaselineEntries(raw)
  if (!r.ok) throw new Error(`esperaba ok, vino: ${r.error}`)
  return r.value
}

function err(raw: unknown): string {
  const r = parseBaselineEntries(raw)
  if (r.ok) throw new Error("esperaba error, pasó")
  return r.error
}

describe("parseBaselineEntries", () => {
  it("acepta los meses previos al POS con su nota", () => {
    const v = ok([
      { month: "2026-01", amount_cents: 4_312_000, note: "  P&L de QuickBooks enero 2026  " },
      { month: "2026-02", amount_cents: 3_900_050 },
    ])
    expect(v.upserts).toEqual([
      { month: "2026-01", amount_cents: 4_312_000, note: "P&L de QuickBooks enero 2026" },
      { month: "2026-02", amount_cents: 3_900_050, note: null },
    ])
    expect(v.deletes).toEqual([])
  })

  it("cero significa SACAR el ajuste, no guardar un ajuste de cero", () => {
    // Guardar la fila dejaría un renglón de auditoría diciendo que alguien
    // sumó nada, y el mes seguiría figurando como ajustado a mano.
    const v = ok([
      { month: "2026-01", amount_cents: 0 },
      { month: "2026-03", amount_cents: 100 },
    ])
    expect(v.deletes).toEqual(["2026-01"])
    expect(v.upserts.map((e) => e.month)).toEqual(["2026-03"])
  })

  it("RECHAZA un monto con decimales — el caso de mandar dólares por centavos", () => {
    // 431.62 es lo que sale de leer un total en pantalla. Un Math.round amable
    // guardaría $4,32 y el gráfico dibujaría una barra plausible cien veces
    // más chica; un 400 se arregla en un minuto.
    const e = err([{ month: "2026-01", amount_cents: 431.62 }])
    expect(e).toMatch(/integer number of CENTS/)
    expect(e).toContain("431.62")
  })

  it("rechaza montos que no son número", () => {
    expect(err([{ month: "2026-01", amount_cents: "4312000" }])).toMatch(/CENTS/)
    expect(err([{ month: "2026-01", amount_cents: null }])).toMatch(/CENTS/)
    expect(err([{ month: "2026-01" }])).toMatch(/CENTS/)
    expect(err([{ month: "2026-01", amount_cents: NaN }])).toMatch(/CENTS/)
    expect(err([{ month: "2026-01", amount_cents: Infinity }])).toMatch(/CENTS/)
  })

  it("acepta un monto NEGATIVO — a un mes se le puede haber contado de más", () => {
    const v = ok([{ month: "2026-04", amount_cents: -125_000 }])
    expect(v.upserts[0].amount_cents).toBe(-125_000)
  })

  it("rechaza un mes repetido en el mismo payload", () => {
    // Elegir uno en silencio guardaría un número que el operador no escribió.
    expect(err([
      { month: "2026-01", amount_cents: 100 },
      { month: "2026-01", amount_cents: 200 },
    ])).toMatch(/appears more than once/)
  })

  it("rechaza meses mal formados", () => {
    for (const month of ["2026-1", "2026-13", "2026-00", "202601", "2026", "", null, 202601]) {
      expect(err([{ month, amount_cents: 100 }])).toMatch(/YYYY-MM/)
    }
  })

  it("rechaza montos fuera de rango en vez de guardar un absurdo", () => {
    expect(err([{ month: "2026-01", amount_cents: 1_000_000_001 }])).toMatch(/out of range/)
    expect(err([{ month: "2026-01", amount_cents: -1_000_000_001 }])).toMatch(/out of range/)
  })

  it("una nota vacía o de puros espacios queda NULL, no cadena vacía", () => {
    const v = ok([
      { month: "2026-01", amount_cents: 100, note: "   " },
      { month: "2026-02", amount_cents: 100, note: "" },
      { month: "2026-03", amount_cents: 100, note: null },
    ])
    expect(v.upserts.map((e) => e.note)).toEqual([null, null, null])
  })

  it("rechaza una nota que no es texto, o demasiado larga", () => {
    expect(err([{ month: "2026-01", amount_cents: 100, note: 42 }])).toMatch(/must be a string/)
    expect(err([{ month: "2026-01", amount_cents: 100, note: "x".repeat(501) }])).toMatch(/at most 500/)
    expect(ok([{ month: "2026-01", amount_cents: 100, note: "x".repeat(500) }]).upserts).toHaveLength(1)
  })

  it("rechaza un cuerpo que no es una lista", () => {
    for (const bad of [undefined, null, {}, "entries", 5]) {
      expect(err(bad)).toMatch(/must be an array/)
    }
    expect(err([null])).toMatch(/must be an object/)
    expect(err(["2026-01"])).toMatch(/must be an object/)
  })

  it("una lista vacía es válida y no hace nada", () => {
    expect(ok([])).toEqual({ upserts: [], deletes: [] })
  })

  it("rechaza un payload absurdamente grande", () => {
    const huge = Array.from({ length: 1201 }, (_, i) => ({
      month: `${2000 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      amount_cents: 100,
    }))
    expect(err(huge)).toMatch(/at most 1200/)
  })
})
