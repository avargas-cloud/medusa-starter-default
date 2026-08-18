/**
 * commission-expr — prorateo puro + agregados de reportes de comisión.
 *
 * Todo en CENTS (ver tabla de unidades en el header de commission-expr.ts).
 */
import {
  fetchAccruedCommissionCentsForPeriod,
  fetchSettledCommissionCentsForPeriod,
  prorateCommissionAcrossInvoices,
} from "../../api/admin/reports/_lib/commission-expr"

describe("prorateCommissionAcrossInvoices", () => {
  it("weights vacío → []", () => {
    expect(prorateCommissionAcrossInvoices(1000, [])).toEqual([])
  })

  it("totalCents = 0 → todos en cero", () => {
    expect(prorateCommissionAcrossInvoices(0, [100, 200, 300])).toEqual([0, 0, 0])
  })

  it("un solo weight → [totalCents]", () => {
    expect(prorateCommissionAcrossInvoices(12345, [999])).toEqual([12345])
  })

  it("suma de weights = 0 → partes iguales, resto a los primeros índices", () => {
    expect(prorateCommissionAcrossInvoices(100, [0, 0, 0])).toEqual([34, 33, 33])
  })

  it("suma de weights = 0, división exacta → partes iguales sin resto", () => {
    expect(prorateCommissionAcrossInvoices(90, [0, 0, 0])).toEqual([30, 30, 30])
  })

  it("weights negativos se tratan como 0 (no atraen comisión)", () => {
    expect(prorateCommissionAcrossInvoices(100, [-5, 10])).toEqual([0, 100])
  })

  it("todos los weights negativos → equivalente a suma 0, partes iguales", () => {
    expect(prorateCommissionAcrossInvoices(10, [-1, -2, -3])).toEqual([4, 3, 3])
  })

  it("residuo real: totalCents=100, weights=[1,1,1] → [34,33,33]", () => {
    expect(prorateCommissionAcrossInvoices(100, [1, 1, 1])).toEqual([34, 33, 33])
  })

  it("weights desiguales: totalCents=1000, weights=[7000,3000] → [700,300]", () => {
    expect(prorateCommissionAcrossInvoices(1000, [7000, 3000])).toEqual([700, 300])
  })

  it("nunca devuelve NaN ni pierde centavos con weights fraccionarios raros", () => {
    const result = prorateCommissionAcrossInvoices(37, [3, 5, 11, 0, 1])
    expect(result.some((n) => Number.isNaN(n))).toBe(false)
    expect(result.reduce((s, n) => s + n, 0)).toBe(37)
  })

  it("invariante: la suma del resultado es EXACTAMENTE totalCents en muchos casos", () => {
    const cases: Array<[number, number[]]> = [
      [1, [1, 1]],
      [2, [1, 1]],
      [3, [1, 1, 1]],
      [100, [1, 2, 3, 4, 5]],
      [9999, [17, 31, 53, 0, 4]],
      [1, [0, 0]],
      [7, [0, 0, 0, 0]],
      [12345, [1, 1, 1, 1, 1, 1, 1]],
      [500, [-10, 20, -5, 30]],
      [0, [1, 2, 3]],
      [1, [5]],
      [8675309, [123, 456, 789, 1011]],
    ]
    for (const [total, weights] of cases) {
      const result = prorateCommissionAcrossInvoices(total, weights)
      expect(result).toHaveLength(weights.length)
      expect(result.reduce((s, n) => s + n, 0)).toBe(Math.round(total))
      expect(result.every((n) => Number.isFinite(n))).toBe(true)
    }
  })

  // Control positivo (mutation test manual, ver reporte de verificación):
  // reemplazando el largest-remainder por un Math.floor puro (sin repartir el
  // resto) este mismo caso rompe la invariante — [100,[1,1,1]] da [33,33,33]
  // (suma 99, no 100). Confirma que el test de arriba SÍ detecta la regresión.
  it("degenerate control: floor puro perdería 1 centavo en [100,[1,1,1]]", () => {
    const floorOnly = [1, 1, 1].map((w) =>
      Math.floor((w / 3) * 100)
    )
    expect(floorOnly.reduce((s, n) => s + n, 0)).toBe(99) // NO 100 — floor puro pierde plata
    // La función real corrige esto con largest-remainder:
    expect(prorateCommissionAcrossInvoices(100, [1, 1, 1]).reduce((s, n) => s + n, 0)).toBe(100)
  })
})

// pg falso: cola de respuestas por orden de llamada a .raw().
function fakePg(responses: Array<{ rows: any[] }>) {
  let call = 0
  return {
    raw: jest.fn(async (_sql: string, _bindings: unknown[]) => {
      const r = responses[call] ?? { rows: [] }
      call += 1
      return r
    }),
  }
}

describe("fetchSettledCommissionCentsForPeriod", () => {
  it("suma amount_cents de settlements confirmed dentro de la ventana (agregación ya la hace el SQL mockeado)", async () => {
    const pg = fakePg([{ rows: [{ settled_cents: "45000" }] }])
    const total = await fetchSettledCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(45000)
    expect(pg.raw).toHaveBeenCalledTimes(1)
  })

  it("sin filas → 0, no NaN", async () => {
    const pg = fakePg([{ rows: [{ settled_cents: null }] }])
    const total = await fetchSettledCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(0)
  })
})

describe("fetchAccruedCommissionCentsForPeriod", () => {
  it("sin comisiones vivas → 0 y no consulta facturas", async () => {
    const pg = fakePg([{ rows: [] }])
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(0)
    expect(pg.raw).toHaveBeenCalledTimes(1)
  })

  it("una orden, una factura, monto congelado (amount_cents no-null) — cuenta si issued_at cae en la ventana", async () => {
    const pg = fakePg([
      {
        rows: [
          {
            order_id: "order_1",
            base_cents: "100000",
            amount_cents: "5000",
            amount_mode: "percent",
            percent_bps: "500",
            fixed_amount_cents: null,
          },
        ],
      },
      {
        rows: [
          {
            order_id: "order_1",
            invoice_id: "inv_1",
            issued_at: "2026-08-15T12:00:00Z",
            net_cents: "100000",
          },
        ],
      },
    ])
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(5000)
  })

  it("amount_cents null → deriva con effectiveAmountCents (percent sobre base)", async () => {
    const pg = fakePg([
      {
        rows: [
          {
            order_id: "order_1",
            base_cents: "100000",
            amount_cents: null,
            amount_mode: "percent",
            percent_bps: "500", // 5% de 100000 = 5000
            fixed_amount_cents: null,
          },
        ],
      },
      {
        rows: [
          {
            order_id: "order_1",
            invoice_id: "inv_1",
            issued_at: "2026-08-15T12:00:00Z",
            net_cents: "100000",
          },
        ],
      },
    ])
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(5000)
  })

  it("amount_mode fixed usa fixed_amount_cents, no percent_bps", async () => {
    const pg = fakePg([
      {
        rows: [
          {
            order_id: "order_1",
            base_cents: "100000",
            amount_cents: null,
            amount_mode: "fixed",
            percent_bps: "0",
            fixed_amount_cents: "2500",
          },
        ],
      },
      {
        rows: [
          {
            order_id: "order_1",
            invoice_id: "inv_1",
            issued_at: "2026-08-15T12:00:00Z",
            net_cents: "100000",
          },
        ],
      },
    ])
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(2500)
  })

  it("orden con DOS facturas en meses distintos — sólo cuenta la porción dentro de la ventana", async () => {
    const pg = fakePg([
      {
        rows: [
          {
            order_id: "order_1",
            base_cents: "100000",
            amount_cents: "1000", // comisión total congelada de la orden
            amount_mode: "percent",
            percent_bps: "0",
            fixed_amount_cents: null,
          },
        ],
      },
      {
        rows: [
          {
            order_id: "order_1",
            invoice_id: "inv_july",
            issued_at: "2026-07-31T23:00:00Z",
            net_cents: "3000", // 30% del net revenue de la orden
          },
          {
            order_id: "order_1",
            invoice_id: "inv_august",
            issued_at: "2026-08-15T12:00:00Z",
            net_cents: "7000", // 70% del net revenue de la orden
          },
        ],
      },
    ])
    // Weights [3000,7000] sobre 1000 cents → [300,700] (largest-remainder exacto).
    // Ventana [agosto 1, sept 1) sólo cubre inv_august → sólo 700.
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(700)
  })

  it("un beneficiario voideado no se filtra en JS — se asume que el SQL ya excluye state='void' (no hay filas de voideados en la fixture)", async () => {
    // El filtro `r.state <> 'void'` vive en el SQL de la función; este test
    // documenta que la agregación en JS no vuelve a filtrar por estado —
    // confía en que la query ya lo hizo (no hay forma de probar el SQL sin DB
    // real desde un unit test).
    const pg = fakePg([{ rows: [] }])
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(0)
  })

  it("dos recipients en la misma orden — se suman antes de prorratear", async () => {
    const pg = fakePg([
      {
        rows: [
          {
            order_id: "order_1",
            base_cents: "100000",
            amount_cents: "4000",
            amount_mode: "percent",
            percent_bps: "0",
            fixed_amount_cents: null,
          },
          {
            order_id: "order_1",
            base_cents: "100000",
            amount_cents: "6000",
            amount_mode: "percent",
            percent_bps: "0",
            fixed_amount_cents: null,
          },
        ],
      },
      {
        rows: [
          {
            order_id: "order_1",
            invoice_id: "inv_1",
            issued_at: "2026-08-15T12:00:00Z",
            net_cents: "100000",
          },
        ],
      },
    ])
    // 4000 + 6000 = 10000, una sola factura → toda la comisión cae en agosto.
    const total = await fetchAccruedCommissionCentsForPeriod(pg, "2026-08-01", "2026-09-01")
    expect(total).toBe(10000)
  })
})
