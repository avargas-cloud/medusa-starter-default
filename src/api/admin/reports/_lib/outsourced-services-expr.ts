/**
 * Order Outsourced Services — agregado para el tile de Sales.
 *
 * Unidad: CENTS (`order_outsourced_service.amount_cents`). El sufijo `Cents`
 * es deliberado — ver la tabla de unidades de `commission-expr.ts`.
 *
 * Base LIQUIDACIÓN, igual que `fetchSettledCommissionCentsForPeriod`: cuenta
 * el servicio cuando quedó `posted` (`settled_at`), no cuando se facturó la
 * orden. Es la misma base del tile de comisiones, así "Gross Profit" del
 * Dashboard resta las dos con un solo criterio. El prorrateo por factura para
 * rentabilidad por orden es otro diseño (`reference_outsourced_services_
 * profitability_design.md`) y no vive acá.
 *
 * Estados: sólo `posted` es costo REALIZADO. `approved`/`settling` son
 * compromiso, `draft` y `void` no cuentan, y de `posted` no hay vuelta
 * (`lib/outsourced-services/settle.ts`).
 */

interface RawPgClient {
  raw: (sql: string, bindings: unknown[]) => Promise<{ rows: any[] }>
}

// Misma convención env-driven que commission-expr.ts / summary-1099.
const REPORT_TIMEZONE = process.env.QB_DOC_TIMEZONE || "America/New_York"

export async function fetchPostedOutsourcedServiceCentsForPeriod(
  pg: RawPgClient,
  from: string,
  to: string
): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(s.amount_cents), 0)::bigint AS posted_cents
       FROM order_outsourced_service s
      WHERE s.deleted_at IS NULL
        AND s.state = 'posted'
        AND (s.settled_at AT TIME ZONE ?) >= ?
        AND (s.settled_at AT TIME ZONE ?) <  ?`,
    [REPORT_TIMEZONE, from, REPORT_TIMEZONE, to]
  )
  return Number(result.rows[0]?.posted_cents ?? 0)
}
