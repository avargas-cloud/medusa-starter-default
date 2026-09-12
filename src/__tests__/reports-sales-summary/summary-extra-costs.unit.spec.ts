/**
 * Los dos agregados nuevos del tile de Sales (2026-09-12):
 *   · subcontratos POSTED por fecha de liquidación (misma base que la comisión)
 *   · saldo sin facturar de las órdenes ABIERTAS (snapshot, sin rango)
 *
 * El SQL está mockeado, así que lo que se afirma acá es la FORMA de la query
 * (qué estados entran, qué se excluye, qué bindings viajan) y la coerción del
 * resultado. La aritmética contra datos reales la valida
 * `verify-sales-summary-costs.ts`.
 */
import { fetchPostedOutsourcedServiceCentsForPeriod } from "../../api/admin/reports/_lib/outsourced-services-expr"
import { fetchOpenOrdersUninvoicedCents } from "../../api/admin/reports/_lib/open-orders-uninvoiced"

function fakePg(responses: Array<{ rows: any[] }>) {
  let call = 0
  const raw = jest.fn(async (_sql: string, _bindings: unknown[]) => {
    const r = responses[call] ?? { rows: [] }
    call += 1
    return r
  })
  return { raw }
}

describe("fetchPostedOutsourcedServiceCentsForPeriod", () => {
  it("suma amount_cents de servicios posted por settled_at en la zona del negocio", async () => {
    const pg = fakePg([{ rows: [{ posted_cents: "100000" }] }])
    const total = await fetchPostedOutsourcedServiceCentsForPeriod(pg, "2026-09-01", "2026-10-01")
    expect(total).toBe(100000)
    const [sql, bindings] = pg.raw.mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/order_outsourced_service/)
    expect(sql).toMatch(/state = 'posted'/)
    expect(sql).toMatch(/deleted_at IS NULL/)
    // Base liquidación: settled_at convertido a la zona del negocio ANTES de comparar,
    // igual que fetchSettledCommissionCentsForPeriod.
    expect(sql).toMatch(/settled_at AT TIME ZONE \?\) >= \?/)
    expect(sql).toMatch(/settled_at AT TIME ZONE \?\) < {1,2}\?/)
    expect(bindings).toEqual([expect.any(String), "2026-09-01", expect.any(String), "2026-10-01"])
  })

  it("sin filas → 0, no NaN", async () => {
    const pg = fakePg([{ rows: [{ posted_cents: null }] }])
    expect(await fetchPostedOutsourcedServiceCentsForPeriod(pg, "2026-09-01", "2026-10-01")).toBe(0)
  })
})

describe("fetchOpenOrdersUninvoicedCents", () => {
  it("devuelve cents y cantidad de órdenes abiertas con saldo sin facturar", async () => {
    const pg = fakePg([{ rows: [{ uninvoiced_cents: "4145853", order_count: "17" }] }])
    const r = await fetchOpenOrdersUninvoicedCents(pg)
    expect(r).toEqual({ uninvoicedCents: 4145853, orderCount: 17 })
    const [sql, bindings] = pg.raw.mock.calls[0] as [string, unknown[]]
    // Abierta = confirmada (pending), ni anulada ni cerrada por el POS. Un draft
    // (estimate) no es una orden; una canceled/completed/archived no está abierta.
    expect(sql).toMatch(/o\.status = 'pending'/)
    expect(sql).toMatch(/qb_sync_status.*IS DISTINCT FROM 'voided'/)
    expect(sql).toMatch(/pos_closed.*IS DISTINCT FROM 'true'/)
    // Facturado = invoices vivas, igual que hydrate-order-rows.
    expect(sql).toMatch(/pos_invoice\.status NOT IN \('draft', 'voided'\)/)
    // El total es el de la proyección (única verdad del dinero de la orden), y
    // una orden sobre-facturada no resta: GREATEST(0, …).
    expect(sql).toMatch(/order_money_projection/)
    expect(sql).toMatch(/GREATEST\(0, /)
    expect(bindings).toEqual([])
  })

  it("sin órdenes → ceros, no NaN", async () => {
    const pg = fakePg([{ rows: [{ uninvoiced_cents: null, order_count: null }] }])
    expect(await fetchOpenOrdersUninvoicedCents(pg)).toEqual({ uninvoicedCents: 0, orderCount: 0 })
  })
})
