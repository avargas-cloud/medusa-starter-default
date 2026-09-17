/**
 * Pago de cliente RECIBIDO → admins + rep de la orden.
 *
 * El hecho es que NACE el pago (`customer_payment`), no que nace una
 * aplicación: linkear un pago del 09/14 a una orden el 09/17 crea una
 * `payment_application` nueva y el aviso decía "Payment received" sobre dinero
 * viejo (PAY-5010, owner 09/17). Por eso se observa `customer_payment` de las
 * últimas 24 h, con dedupe POR PAGO: un pago aplicado a dos facturas avisa una
 * vez. La factura/orden del aviso sale de su primera aplicación viva, o de
 * `locked_order_id` (depósito de estimate) si aún no se aplicó.
 *
 * Se observa en vez de enganchar las 5 rutas que crean pagos: el aviso no puede
 * romper un cobro, y un job que re-escanea es idempotente. Ventana de 24 h para
 * que un backfill o un deploy tras días caídos no dispare cientos de avisos.
 * Crédito / credit memo / store credit / refund no son dinero recibido.
 */

import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { centsToUsd, customerLabel, methodLabel } from "./format";

export const PAYMENT_EXCLUDED_METHODS = ["credit", "credit_memo", "store_credit"];
export const PAYMENT_EXCLUDED_TYPES = ["credit_memo", "refund"];
export const PAYMENT_WINDOW_HOURS_DEFAULT = 24;

export interface PaymentRow {
  id: string;
  display_id: number | null;
  amount: string | number;
  method: string | null;
  received_at: string | Date | null;
  created_at: string | Date;
  invoice_id: string | null;
  invoice_number: string | null;
  order_id: string | null;
  order_display_id: number | null;
  document_number: string | null;
  rep_initials: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export function paymentDedupeKey(paymentId: string): string {
  return `payment_received:${paymentId}`;
}

export const PAYMENT_SCAN_SQL = `
  SELECT cp.id, cp.display_id, cp.amount, cp.method, cp.received_at, cp.created_at,
         pa.invoice_id, pa.invoice_number,
         COALESCE(pa.order_id, cp.locked_order_id) AS order_id,
         o.display_id AS order_display_id,
         o.metadata->>'document_number' AS document_number,
         o.metadata->'sales_rep'->>'initials' AS rep_initials,
         c.company_name, c.first_name, c.last_name, COALESCE(c.email, o.email) AS email
    FROM customer_payment cp
    LEFT JOIN LATERAL (
      SELECT x.invoice_id, x.invoice_number, x.order_id
        FROM payment_application x
       WHERE x.payment_id = cp.id AND x.deleted_at IS NULL AND x.voided_at IS NULL
       ORDER BY x.created_at ASC
       LIMIT 1
    ) pa ON TRUE
    LEFT JOIN "order" o ON o.id = COALESCE(pa.order_id, cp.locked_order_id)
    LEFT JOIN customer c ON c.id = COALESCE(o.customer_id, cp.customer_id)
   WHERE cp.deleted_at IS NULL
     AND cp.status <> 'voided'
     AND cp.created_at > NOW() - ($1::int * INTERVAL '1 hour')
     AND (cp.method IS NULL OR NOT (cp.method = ANY($2::text[])))
     AND (cp.type IS NULL OR NOT (cp.type = ANY($3::text[])))
     AND NOT EXISTS (
       SELECT 1 FROM pos_notification n WHERE n.dedupe_key = 'payment_received:' || cp.id
     )
   ORDER BY cp.created_at ASC
   LIMIT 200`;

export function buildPaymentNotification(row: PaymentRow) {
  const amount = centsToUsd(row.amount);
  const invoice = row.invoice_number ? ` · ${row.invoice_number}` : "";
  const orderLabel = row.document_number ?? (row.order_display_id ? `#${row.order_display_id}` : null);
  const bodyParts = [customerLabel(row)];
  if (orderLabel) bodyParts.push(`Order ${orderLabel}`);
  if (row.display_id) bodyParts.push(`PAY-${row.display_id}`);
  return {
    kind: "payment_received" as const,
    severity: "info" as const,
    title: `Payment received — ${amount} (${methodLabel(row.method)})${invoice}`,
    body: bodyParts.join(" · "),
    action_url: row.invoice_id ? `/invoices/${row.invoice_id}` : row.order_id ? `/orders/${row.order_id}` : `/payments`,
    entity_type: "customer_payment",
    entity_id: row.id,
    payload: {
      payment_id: row.id,
      invoice_id: row.invoice_id,
      order_id: row.order_id,
      amount_cents: Number.parseFloat(String(row.amount)),
      method: row.method,
      rep_initials: row.rep_initials,
    },
    dedupe_key: paymentDedupeKey(row.id),
    occurred_at: row.received_at ?? row.created_at,
    audiences: [{ kind: "admins" as const }, { kind: "rep" as const, initials: row.rep_initials }],
  };
}

export async function producePaymentNotifications(
  db: Db,
  opts: { windowHours?: number } = {}
): Promise<{ scanned: number; created: number; results: PublishResult[] }> {
  const { rows } = await db.query<PaymentRow>(PAYMENT_SCAN_SQL, [
    opts.windowHours ?? PAYMENT_WINDOW_HOURS_DEFAULT,
    PAYMENT_EXCLUDED_METHODS,
    PAYMENT_EXCLUDED_TYPES,
  ]);
  const results: PublishResult[] = [];
  for (const row of rows) {
    results.push(await publishNotification(db, buildPaymentNotification(row)));
  }
  return { scanned: rows.length, created: results.filter((r) => r.created).length, results };
}
