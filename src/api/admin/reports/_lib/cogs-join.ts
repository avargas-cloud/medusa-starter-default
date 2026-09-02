// average_unit_cost (frozen snapshot) and the canonical average_cost are in dollars.
// pos_invoice.total / pos_invoice_item.total are in cents — divide by 100 in JS before returning.
// COST_DOLLARS returns cost already in dollars so no extra division needed.
import { avgCostDollars } from "../../../../lib/cost/cost-sql"

export const COGS_JOIN = `LEFT JOIN product_variant pv ON pv.id = pii.variant_id`

// Frozen per-line snapshot first; then the canonical live cost (origin-correct
// average_cost → purchase). Replaces the old qb_avg_cost fallback, which was
// wrong for China (stale QB avg instead of the landed cost).
export const COST_DOLLARS = `
  COALESCE(pii.average_unit_cost, ${avgCostDollars("pv")}, 0)
  * pii.quantity
`

export const HAS_COST = `
  (pii.average_unit_cost IS NOT NULL OR ${avgCostDollars("pv")} IS NOT NULL)
`

/**
 * Cost of merchandise RETURNED to stock in [from, to) — the COGS *reversal*
 * leg that pairs with `fetchCmRefundsCentsForPeriod`'s revenue reversal.
 *
 * Why this exists (2026-07-23): the canonical revenue figure is NET of refunds
 * (see sales-revenue.ts) but COGS was gross — it never reversed the cost of
 * goods that physically came back. That understates gross profit, and on the
 * supply-chain report it showed up as a hole between the arrows and the
 * Initial → Final inventory swing (June 2026: $1,266.81).
 *
 * Three choices, all deliberate and all matching what the stock ledger does:
 *   - `quantity − damaged_qty`, NOT `quantity`. Damaged units are refunded but
 *     never restocked (credit_memos/[id]/complete restocks exactly this), so
 *     their cost stays an expense — there's no inventory to put it back into.
 *   - `cm.completed_at` + `status = 'completed'`, mirroring the refund leg's
 *     window: stock comes back when the memo is COMPLETED, not when it's
 *     drafted.
 *   - `cmi.average_unit_cost` first, same frozen-snapshot-then-live fallback
 *     as COST_DOLLARS, so the reversal is on the same basis as the charge.
 */
export async function fetchReturnedProductCostDollars(
  pg: { raw: (sql: string, bindings: unknown[]) => Promise<{ rows: { cost?: string | number }[] }> },
  from: string,
  to: string
): Promise<number> {
  const result = await pg.raw(
    `SELECT COALESCE(SUM(
       COALESCE(cmi.average_unit_cost, ${avgCostDollars("pv")}, 0)
       * GREATEST(0, cmi.quantity - COALESCE(cmi.damaged_qty, 0))
     ), 0) AS cost
     FROM pos_credit_memo cm
     JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
     LEFT JOIN product_variant pv ON pv.id = cmi.variant_id AND pv.deleted_at IS NULL
     WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
       AND COALESCE(cm.completed_at, cm.created_at) >= ?
       AND COALESCE(cm.completed_at, cm.created_at) <  ?`,
    [from, to]
  )
  return Number(result.rows[0]?.cost ?? 0)
}

/**
 * Costo de la mercadería DEVUELTA, listo para restar del COGS, en dólares y
 * **por grano** — no un total del período.
 *
 * ## Por qué hace falta
 *
 * Cuando un cliente devuelve, pasan dos cosas: le devolvés la plata y la
 * mercadería vuelve al estante. Los reportes netean lo primero y **no** lo
 * segundo, así que cobran el costo de algo que nunca vendieron y el gross
 * profit sale más chico de lo que fue: $7,219.06 subestimados en 2026.
 *
 * `fetchReturnedProductCostDollars` (arriba) ya hacía esta reversión, pero
 * devuelve UN número del período entero y por eso sólo le sirve a
 * `purchases/supply-chain`, que reporta un total. Un reporte que agrupa por
 * cliente o por producto necesita el costo repartido en ESE grano; de ahí estos
 * dos CTEs, mismo patrón que `CM_REFUNDS_BY_CUSTOMER_CTE` en `sales-revenue.ts`.
 *
 * ## La regla que no se puede tocar
 *
 * `GREATEST(0, quantity - damaged_qty)`. Una unidad devuelta DAÑADA se le
 * reembolsa al cliente pero **no vuelve al estante** — `credit_memos/[id]/complete`
 * restockea exactamente esta diferencia — así que su costo sigue siendo un gasto
 * real y no se revierte. En 2026 fueron 25 unidades en 23 líneas. Quien "corrija"
 * esto para que el número cierre más redondo rompe justo lo que lo hace correcto.
 *
 * El costo usa el MISMO fallback que `COST_DOLLARS` (snapshot congelado primero,
 * costo canónico vivo después), o la reversión quedaría en otra base que el cargo.
 *
 * Cada CTE lleva DOS placeholders `?` (desde, hasta), en el orden en que aparece
 * en el texto del SQL: al insertarlo hay que reacomodar los bindings de la ruta.
 */
const RETURNED_COST_SELECT = `
    COALESCE(cmi.average_unit_cost, ${avgCostDollars("pv")}, 0)
    * GREATEST(0, cmi.quantity - COALESCE(cmi.damaged_qty, 0))`;

const RETURNED_COST_FROM = `
  FROM pos_credit_memo cm
  JOIN pos_credit_memo_item cmi ON cmi.credit_memo_id = cm.id AND cmi.deleted_at IS NULL
  LEFT JOIN product_variant pv ON pv.id = cmi.variant_id AND pv.deleted_at IS NULL
  WHERE cm.deleted_at IS NULL AND cm.voided_at IS NULL AND cm.status = 'completed'
    AND COALESCE(cm.completed_at, cm.created_at) >= ?
    AND COALESCE(cm.completed_at, cm.created_at) <  ?`;

/** Costo devuelto por CLIENTE. Alias del CTE: `returned_cost`. */
export const RETURNED_COST_BY_CUSTOMER_CTE = `
  returned_cost AS (
    SELECT cm.customer_id, SUM(${RETURNED_COST_SELECT}) AS returned_cost_dollars
    ${RETURNED_COST_FROM}
      AND cm.customer_id IS NOT NULL
    GROUP BY cm.customer_id
  )
`;

/** Costo devuelto por VARIANTE. Alias del CTE: `returned_cost_variant`. */
export const RETURNED_COST_BY_VARIANT_CTE = `
  returned_cost_variant AS (
    SELECT cmi.variant_id, SUM(${RETURNED_COST_SELECT}) AS returned_cost_dollars
    ${RETURNED_COST_FROM}
      AND cmi.variant_id IS NOT NULL
    GROUP BY cmi.variant_id
  )
`;
