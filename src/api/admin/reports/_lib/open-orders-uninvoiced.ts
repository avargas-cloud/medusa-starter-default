/**
 * Saldo SIN FACTURAR de las órdenes abiertas — tile "Open Orders" de Sales.
 *
 * Es un SNAPSHOT, no una serie: no recibe rango porque "lo que falta facturar
 * hoy" no tiene período. Unidad: CENTS.
 *
 * Abierta = `order.status = 'pending'` (confirmada) que no esté anulada
 * (`metadata.qb_sync_status = 'voided'`, el mismo criterio de
 * `build-order-doc.ts`) ni cerrada desde el POS (`metadata.pos_closed`).
 * `draft` es un estimate, no una orden; `completed`/`archived`/`canceled`
 * no están abiertas. En prod (2026-09-12) los drafts sumaban $1.09M — es lo
 * que este filtro deja afuera a propósito.
 *
 * Total = `order_money_projection.order_total_cents` (la única verdad del
 * dinero de una orden). Facturado = `pos_invoice.total` de las invoices vivas,
 * igual que `orders/_lib/hydrate-order-rows.ts`. Una orden sobre-facturada
 * (S10075 al 2×) no resta del resto: `GREATEST(0, …)` por orden.
 */

interface RawPgClient {
  raw: (sql: string, bindings: unknown[]) => Promise<{ rows: any[] }>
}

export interface OpenOrdersUninvoiced {
  uninvoicedCents: number
  orderCount: number
}

export async function fetchOpenOrdersUninvoicedCents(
  pg: RawPgClient
): Promise<OpenOrdersUninvoiced> {
  const result = await pg.raw(
    `WITH invoiced AS (
       SELECT pos_invoice.order_id, SUM(pos_invoice.total) AS invoiced_cents
         FROM pos_invoice
        WHERE pos_invoice.deleted_at IS NULL
          AND pos_invoice.status NOT IN ('draft', 'voided')
        GROUP BY pos_invoice.order_id
     ),
     open_balance AS (
       SELECT GREATEST(0, p.order_total_cents - COALESCE(inv.invoiced_cents, 0)) AS cents
         FROM "order" o
         JOIN order_money_projection p ON p.order_id = o.id
         LEFT JOIN invoiced inv ON inv.order_id = o.id
        WHERE o.deleted_at IS NULL
          AND o.status = 'pending'
          AND (o.metadata->>'qb_sync_status') IS DISTINCT FROM 'voided'
          AND (o.metadata->>'pos_closed') IS DISTINCT FROM 'true'
     )
     SELECT COALESCE(SUM(cents), 0)::bigint AS uninvoiced_cents,
            COUNT(*) FILTER (WHERE cents > 0)::int AS order_count
       FROM open_balance`,
    []
  )
  const row = result.rows[0] ?? {}
  return {
    uninvoicedCents: Number(row.uninvoiced_cents ?? 0),
    orderCount: Number(row.order_count ?? 0),
  }
}
