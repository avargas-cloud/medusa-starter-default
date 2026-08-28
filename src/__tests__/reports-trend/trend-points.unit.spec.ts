/**
 * mergeTrendPoints — la aritmética del gráfico de ventas.
 *
 * Existe porque el endpoint `sales/trend` shipeó sin restar devoluciones: el
 * gráfico dibujaba el bruto mientras los tiles de arriba, en la MISMA pantalla,
 * mostraban el neto, y la línea de "Gross Profit" venía inflada por el monto
 * completo de los reembolsos encima de eso. Medido contra producción el
 * 2026-08-28: $18.435,24 en 131 credit memos completados en el año, todos los
 * meses. Nada fallaba, nada tiraba error — los dos números simplemente no
 * cerraban, y el que los reportó fue el dueño mirando la pantalla.
 *
 * Los fixtures son los seis meses reales de producción, con el bruto y las
 * devoluciones que los generaron.
 */
import { mergeTrendPoints } from "../../api/admin/reports/_lib/trend-points"

/** Ventas por mes de 2026, tal como salen del SQL: revenue en CENTAVOS, cogs en DÓLARES. */
const SALES = [
  { bucket: "2026-01", revenue: 43162, cogs: 244 },
  { bucket: "2026-04", revenue: 5093626, cogs: 23828 },
  { bucket: "2026-05", revenue: 10650964, cogs: 49622 },
  { bucket: "2026-06", revenue: 11138984, cogs: 53084 },
  { bucket: "2026-07", revenue: 11417435, cogs: 57342 },
  { bucket: "2026-08", revenue: 12302288, cogs: 55502 },
]

/** Credit memos completados, en CENTAVOS, fechados por completed_at. */
const REFUNDS = [
  { bucket: "2026-04", refund_cents: 393277 },
  { bucket: "2026-05", refund_cents: 341120 },
  { bucket: "2026-06", refund_cents: 319804 },
  { bucket: "2026-07", refund_cents: 469995 },
  { bucket: "2026-08", refund_cents: 319328 },
]

const round2 = (n: number) => Math.round(n * 100) / 100

describe("mergeTrendPoints", () => {
  it("resta las devoluciones del mes en que el reembolso ocurrió", () => {
    const points = mergeTrendPoints(SALES, REFUNDS)
    const july = points.find((p) => p.label === "2026-07")!

    expect(july.gross_revenue).toBe(114174.35)
    expect(july.refunded).toBe(4699.95)
    expect(july.revenue).toBe(109474.4)
    expect(round2(july.gross_revenue - july.refunded)).toBe(july.revenue)
  })

  it("deriva el profit del NETO, no del bruto — la definición del summary", () => {
    const points = mergeTrendPoints(SALES, REFUNDS)
    const july = points.find((p) => p.label === "2026-07")!

    // gross_profit = net_revenue − COGS. Derivarlo del bruto lo inflaría
    // exactamente en el monto de los reembolsos ($4.699,95), que es el bug.
    expect(round2(july.profit)).toBe(round2(109474.4 - 57342))
    expect(july.profit).not.toBe(round2(114174.35 - 57342))
  })

  it("el margen se mide sobre el neto", () => {
    const july = mergeTrendPoints(SALES, REFUNDS).find((p) => p.label === "2026-07")!
    const expected = Math.round(((109474.4 - 57342) / 109474.4) * 1000) / 10
    expect(july.margin).toBe(expected)
  })

  it("un mes sin devoluciones queda idéntico a su bruto", () => {
    const jan = mergeTrendPoints(SALES, REFUNDS).find((p) => p.label === "2026-01")!
    expect(jan.refunded).toBe(0)
    expect(jan.revenue).toBe(jan.gross_revenue)
    expect(jan.revenue).toBe(431.62)
  })

  it("un mes cuya ÚNICA actividad fue una devolución se dibuja, en negativo", () => {
    // Sin la unión de claves este mes desaparecería del gráfico y la plata que
    // salió no aparecería en ningún lado.
    const points = mergeTrendPoints(
      [{ bucket: "2026-05", revenue: 100000, cogs: 400 }],
      [
        { bucket: "2026-05", refund_cents: 10000 },
        { bucket: "2026-06", refund_cents: 25000 },
      ]
    )
    expect(points.map((p) => p.label)).toEqual(["2026-05", "2026-06"])

    const june = points[1]
    expect(june.gross_revenue).toBe(0)
    expect(june.refunded).toBe(250)
    expect(june.revenue).toBe(-250)
    expect(june.profit).toBe(-250)
    // Un margen sobre un neto no positivo no existe: 0 es el marcador honesto,
    // y evita mandarle al eje derecho (fijo 0–100) un valor que no puede dibujar.
    expect(june.margin).toBe(0)
  })

  it("los buckets salen en orden de calendario, en los dos formatos de label", () => {
    const months = mergeTrendPoints(
      [
        { bucket: "2026-10", revenue: 100, cogs: 0 },
        { bucket: "2026-02", revenue: 100, cogs: 0 },
      ],
      [{ bucket: "2026-07", refund_cents: 100 }]
    )
    expect(months.map((p) => p.label)).toEqual(["2026-02", "2026-07", "2026-10"])

    const days = mergeTrendPoints(
      [
        { bucket: "2026-08-09", revenue: 100, cogs: 0 },
        { bucket: "2026-08-10", revenue: 100, cogs: 0 },
      ],
      [{ bucket: "2026-08-02", refund_cents: 100 }]
    )
    expect(days.map((p) => p.label)).toEqual(["2026-08-02", "2026-08-09", "2026-08-10"])
  })

  it("coerciona montos que llegan como string", () => {
    // Postgres devuelve ::bigint como string por el driver: un `+` sobre eso
    // concatena en silencio, que es el gotcha transversal del repo.
    const [p] = mergeTrendPoints(
      [{ bucket: "2026-05", revenue: "10650964", cogs: "49622" }],
      [{ bucket: "2026-05", refund_cents: "341120" }]
    )
    expect(p.gross_revenue).toBe(106509.64)
    expect(p.refunded).toBe(3411.2)
    expect(p.revenue).toBe(103098.44)
  })

  it("el total del año cierra contra el neto medido en producción", () => {
    const points = mergeTrendPoints(SALES, REFUNDS)
    expect(round2(points.reduce((s, p) => s + p.gross_revenue, 0))).toBe(506464.59)
    expect(round2(points.reduce((s, p) => s + p.refunded, 0))).toBe(18435.24)
    expect(round2(points.reduce((s, p) => s + p.revenue, 0))).toBe(488029.35)
  })

  it("sin filas devuelve una serie vacía, no una fila fantasma", () => {
    expect(mergeTrendPoints([], [])).toEqual([])
  })
})
