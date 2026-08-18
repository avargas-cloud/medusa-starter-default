/**
 * Order Commissions — lector del dinero de la orden (solo lectura).
 *
 * Fuentes canónicas, nunca aritmética sobre `order.total`:
 * · Subtotal/descuento: `loadOrderMoneyBase()` (lib/order-money/order-tax-lines) —
 *   devuelve DÓLARES; `netDollars` ya viene neto de adjustments, así que el
 *   subtotal pre-descuento es net + adjustments. El descuento por LÍNEA baked
 *   en `unit_price` es el precio del ítem a efectos de comisión (el ejemplo
 *   canónico del owner mide contra el subtotal de la orden, §2.1).
 * · Pago completo: `order_money_projection` — la plata entró cuando
 *   applied + deposit cubre el total (un depósito sin aplicar ES plata que
 *   entró; lo que protege la regla es no comisionar plata inexistente).
 * · Última factura: `pos_invoice` viva no-draft más reciente de la orden.
 */

import type { PoolClient } from "pg";

import { loadOrderMoneyBase } from "../order-money/order-tax-lines";
import type { OrderMoneySnapshot } from "./writer";

export interface OrderMoneyContext extends OrderMoneySnapshot {
  orderCustomerId: string | null;
  currencyCode: string;
  orderDisplayId: string | null;
  orderStatus: string | null;
}

export async function readOrderMoneySnapshot(
  client: PoolClient,
  orderId: string
): Promise<OrderMoneyContext | null> {
  const { rows: orderRows } = await client.query<{
    customer_id: string | null;
    currency_code: string | null;
    display_id: string | number | null;
    status: string | null;
  }>(
    `SELECT customer_id, currency_code, display_id, status
       FROM "order" WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [orderId]
  );
  const order = orderRows[0];
  if (!order) return null;

  const base = await loadOrderMoneyBase(client, orderId);
  const discountCents = Math.round(base.adjustmentsDollars * 100);
  const itemSubtotalCents = Math.round(base.netDollars * 100) + discountCents;

  const { rows: moneyRows } = await client.query<{
    fully_paid: boolean;
    paid_at: Date | null;
  }>(
    `SELECT (omp.order_total_cents > 0
             AND omp.applied_cents + omp.deposit_cents >= omp.order_total_cents) AS fully_paid,
            GREATEST(
              (SELECT MAX(pa.created_at) FROM payment_application pa
                WHERE pa.order_id = $1 AND pa.deleted_at IS NULL AND pa.voided_at IS NULL),
              (SELECT MAX(cp.created_at) FROM customer_payment cp
                WHERE COALESCE(cp.locked_order_id, cp.metadata->>'order_id') = $1
                  AND cp.deleted_at IS NULL
                  AND COALESCE(cp.status, '') NOT IN ('voided', 'refunded'))
            ) AS paid_at
       FROM order_money_projection omp
      WHERE omp.order_id = $1`,
    [orderId]
  );
  const money = moneyRows[0];
  const fullyPaidAt = money?.fully_paid && money.paid_at ? money.paid_at : null;

  const { rows: invoiceRows } = await client.query<{ last_invoice_at: Date | null }>(
    `SELECT MAX(created_at) AS last_invoice_at
       FROM pos_invoice
      WHERE order_id = $1
        AND deleted_at IS NULL
        AND status NOT IN ('draft', 'voided')`,
    [orderId]
  );
  const lastInvoiceAt = invoiceRows[0]?.last_invoice_at ?? null;

  return {
    itemSubtotalCents,
    discountCents,
    fullyPaidAt,
    lastInvoiceAt,
    orderCustomerId: order.customer_id,
    currencyCode: order.currency_code ?? "usd",
    orderDisplayId: order.display_id == null ? null : String(order.display_id),
    orderStatus: order.status,
  };
}
