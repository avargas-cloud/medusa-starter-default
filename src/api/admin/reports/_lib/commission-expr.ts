/**
 * Order Commissions — expresiones y agregados para reportes.
 *
 * ⚠️ TABLA DE UNIDADES (léela antes de tocar este archivo):
 *
 *   | Fuente                                          | Unidad   |
 *   |--------------------------------------------------|----------|
 *   | NET_ITEM_REVENUE (revenue-expr.ts)               | CENTS    |
 *   | COST_DOLLARS (cogs-join.ts)                      | DÓLARES  |
 *   | order_commission_recipient.amount_cents          | CENTS    |
 *   | order_commission.base_cents                      | CENTS    |
 *   | commission_settlement.amount_cents               | CENTS    |
 *
 * Todo lo que este archivo exporta va en CENTS — de ahí el sufijo `Cents` en
 * cada función. Este repo ya reportó $17.162 donde la factura era $171.62 por
 * asumir dólares donde había cents (`project_qb_reverse_void_audit.md`); no
 * repetirlo.
 */
import {
  effectiveAmountCents,
  type CommissionAmountMode,
} from "../../../../lib/commissions/calculator"
import { NET_ITEM_REVENUE } from "./revenue-expr"

/**
 * Reparte `totalCents` entre N facturas, proporcional a `weights` (net
 * revenue por factura, en cents), con largest-remainder: la suma del
 * resultado es EXACTAMENTE `totalCents`.
 *
 * NO reusa `allocateLineTotalsCents` (`lib/purchase-orders/landed-allocation.ts`)
 * a propósito: esa función, cuando la suma de weights es <= 0, devuelve TODO
 * en cero (correcto para un pool de landed cost sin dónde apoyarse — un pool
 * "no colocable" debe reportarse, no repartirse). Esta función necesita lo
 * contrario: varias facturas de una misma orden en $0 de revenue neto (por
 * ej. una orden 100% cubierta por un descuento) igual reparten la comisión en
 * partes iguales, porque la comisión existe y hay que asignarla a alguna
 * factura — no hay un "pool sin dónde colocarse" que reportar como huérfano.
 *
 * Reglas:
 *  - `weights` vacío → `[]`.
 *  - `totalCents === 0` → todo en cero.
 *  - Un solo weight → `[totalCents]`.
 *  - weights negativos se tratan como 0 (un net revenue negativo no atrae
 *    comisión), pero SIGUEN contando para el largo del array de salida.
 *  - Si la suma de weights (ya clampeados a >=0) es 0, se reparte en partes
 *    iguales; el resto no divisible va a los PRIMEROS índices.
 *  - En cualquier otro caso, floor proporcional + largest-remainder; empates
 *    de remainder se resuelven por índice ascendente (determinístico).
 */
export function prorateCommissionAcrossInvoices(
  totalCents: number,
  weights: number[]
): number[] {
  const n = weights.length
  if (n === 0) return []

  const total = Math.round(totalCents)
  if (total === 0) return new Array(n).fill(0)

  const clamped = weights.map((w) => Math.max(0, w))
  const totalWeight = clamped.reduce((s, w) => s + w, 0)

  if (totalWeight <= 0) {
    // Ninguna factura "atrae" comisión por su revenue — partes iguales,
    // resto a los primeros índices.
    const base = Math.floor(total / n)
    const remainder = total - base * n
    return clamped.map((_, i) => base + (i < remainder ? 1 : 0))
  }

  const exact = clamped.map((w) => (w / totalWeight) * total)
  const floored = exact.map((e) => Math.floor(e))
  const allocated = floored.reduce((s, v) => s + v, 0)
  let leftover = total - allocated

  const frac = exact.map((e, i) => e - floored[i]!)
  const order = [...Array(n).keys()].sort(
    (a, b) => (frac[b] ?? 0) - (frac[a] ?? 0) || a - b
  )

  const out = [...floored]
  for (let k = 0; leftover > 0 && k < order.length; k++, leftover--) {
    const i = order[k]!
    out[i] = (out[i] ?? 0) + 1
  }
  return out
}

interface RawPgClient {
  raw: (sql: string, bindings: unknown[]) => Promise<{ rows: any[] }>
}

// Misma convención documentada que `commissions/summary-1099/route.ts` —
// tercera copia local del mismo default env-driven (las otras dos:
// `lib/quickbooks/order-flow-core.ts` QB_DOC_TIMEZONE, `lib/finance/batch-day.ts`
// BATCH_TIMEZONE — ninguna exportada).
const REPORT_TIMEZONE = process.env.QB_DOC_TIMEZONE || "America/New_York"

/**
 * Comisión LIQUIDADA en el período [from, to) — base de "liquidación".
 *
 * Suma `commission_settlement.amount_cents` de settlements `confirmed`,
 * fechados por `COALESCE(r.settled_at, s.updated_at)`. Convertido a la zona
 * horaria del negocio ANTES de comparar (igual que summary-1099): una
 * liquidación de fin de diciembre en horario del este no puede caer en el
 * año/período siguiente por comparar en UTC.
 */
export async function fetchSettledCommissionCentsForPeriod(
  pg: RawPgClient,
  from: string,
  to: string
): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(s.amount_cents), 0)::bigint AS settled_cents
       FROM commission_settlement s
       JOIN order_commission_recipient r ON r.id = s.recipient_id
      WHERE s.status = 'confirmed'
        AND (COALESCE(r.settled_at, s.updated_at) AT TIME ZONE ?) >= ?
        AND (COALESCE(r.settled_at, s.updated_at) AT TIME ZONE ?) <  ?`,
    [REPORT_TIMEZONE, from, REPORT_TIMEZONE, to]
  )
  return Number(result.rows[0]?.settled_cents ?? 0)
}

interface RawRecipientRow {
  order_id: string
  base_cents: string | number
  amount_cents: string | number | null
  amount_mode: CommissionAmountMode
  percent_bps: string | number
  fixed_amount_cents: string | number | null
}

interface RawInvoiceRow {
  order_id: string
  invoice_id: string
  issued_at: string | Date
  net_cents: string | number
}

/**
 * Comisión DEVENGADA en el período [from, to) — base "devengado".
 *
 * La comisión se atribuye a la fecha de la FACTURA (`pos_invoice.issued_at`,
 * igual que el resto de los reportes de ventas), y una orden puede tener
 * varias facturas — así que el monto total de comisión de la orden se
 * prorratea entre sus facturas por net revenue (`NET_ITEM_REVENUE`) y sólo
 * cuenta la porción de las facturas cuyo `issued_at` cae en la ventana.
 *
 * ⚠️ Esto hace los reportes de margen RETROACTIVAMENTE MUTABLES: una
 * comisión recién aprobada en octubre puede reasignar centavos al margen de
 * agosto (la factura de agosto ya existía; lo que cambió es cuánta comisión
 * le corresponde). Esto es INHERENTE al devengo, no un defecto — la
 * comisión se asigna después de la venta, y "devengado" significa medir la
 * economía real de esa venta con la información que hoy se tiene de ella.
 *
 * El monto de cada recipient se calcula en JS con `effectiveAmountCents`
 * (la función REAL de `lib/commissions/calculator.ts`) — jamás se replica la
 * fórmula en SQL, que sería la tercera copia del mismo cálculo.
 *
 * ⚠️ ASIMETRÍA DE ZONA HORARIA DELIBERADA, no la "arregles":
 * esta función compara `issued_at` como INSTANTE (sin `AT TIME ZONE`), mientras
 * `fetchSettledCommissionCentsForPeriod` sí convierte. Los dos criterios son
 * correctos porque miden cosas distintas:
 *   · devengado  → tiene que alinearse EXACTAMENTE con `SALES_DATE_FILTER_SQL`
 *     (`i.issued_at >= ? AND i.issued_at < ?`, sin conversión), que es lo que
 *     usan revenue y COGS en todos los reportes de ventas. Si acá se convirtiera
 *     y allá no, la comisión y el revenue del MISMO reporte medirían ventanas
 *     distintas y el margen saldría mal en los bordes del período.
 *   · liquidación → es un corte fiscal sobre un evento contable propio, y ahí la
 *     zona del negocio es la que manda (misma lección que el 1099, donde
 *     comparar en UTC mandaba una liquidación del 31-dic al año siguiente).
 * Unificarlas exigiría cambiar `SALES_DATE_FILTER_SQL` para TODOS los reportes,
 * que es un cambio de otro tamaño y está fuera de alcance.
 */
export async function fetchAccruedCommissionCentsForPeriod(
  pg: RawPgClient,
  from: string,
  to: string
): Promise<number> {
  const commissionResult = await pg.raw(
    `SELECT c.order_id,
            c.base_cents,
            r.amount_cents,
            r.amount_mode,
            r.percent_bps,
            r.fixed_amount_cents
       FROM order_commission c
       JOIN order_commission_recipient r ON r.order_commission_id = c.id
      WHERE c.deleted_at IS NULL
        AND r.deleted_at IS NULL
        AND r.state <> 'void'`,
    []
  )
  const recipientRows = commissionResult.rows as RawRecipientRow[]
  if (recipientRows.length === 0) return 0

  const orderIds = [...new Set(recipientRows.map((r) => r.order_id))]

  const invoiceResult = await pg.raw(
    `SELECT i.order_id,
            i.id AS invoice_id,
            i.issued_at,
            SUM(${NET_ITEM_REVENUE})::bigint AS net_cents
       FROM pos_invoice i
       JOIN pos_invoice_item pii ON pii.invoice_id = i.id AND pii.deleted_at IS NULL
      WHERE i.deleted_at IS NULL
        AND i.status NOT IN ('draft','voided')
        AND i.order_id = ANY(?)
      GROUP BY i.order_id, i.id, i.issued_at`,
    [orderIds]
  )
  const invoiceRows = invoiceResult.rows as RawInvoiceRow[]

  const recipientsByOrder = new Map<string, RawRecipientRow[]>()
  for (const row of recipientRows) {
    const list = recipientsByOrder.get(row.order_id) ?? []
    list.push(row)
    recipientsByOrder.set(row.order_id, list)
  }

  const invoicesByOrder = new Map<string, RawInvoiceRow[]>()
  for (const row of invoiceRows) {
    const list = invoicesByOrder.get(row.order_id) ?? []
    list.push(row)
    invoicesByOrder.set(row.order_id, list)
  }

  const fromMs = new Date(from).getTime()
  const toMs = new Date(to).getTime()

  let totalCents = 0
  for (const [orderId, recipients] of recipientsByOrder) {
    const invoices = invoicesByOrder.get(orderId)
    if (!invoices || invoices.length === 0) continue

    const baseCents = Number(recipients[0]!.base_cents)
    const orderCommissionCents = recipients.reduce((sum, r) => {
      const amount =
        r.amount_cents != null
          ? Number(r.amount_cents)
          : effectiveAmountCents(baseCents, {
              mode: r.amount_mode,
              percentBps: Number(r.percent_bps),
              fixedAmountCents:
                r.fixed_amount_cents != null ? Number(r.fixed_amount_cents) : null,
            })
      return sum + amount
    }, 0)

    const weights = invoices.map((inv) => Number(inv.net_cents))
    const portions = prorateCommissionAcrossInvoices(orderCommissionCents, weights)

    invoices.forEach((inv, i) => {
      const issuedAtMs = new Date(inv.issued_at).getTime()
      if (issuedAtMs >= fromMs && issuedAtMs < toMs) {
        totalCents += portions[i] ?? 0
      }
    })
  }

  return totalCents
}
