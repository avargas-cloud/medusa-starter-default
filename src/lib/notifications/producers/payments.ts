/**
 * Pago de cliente aplicado a una factura → admins + rep de la orden.
 *
 * Se OBSERVA `payment_application` (la fila que nace en cada aplicación, por
 * cualquiera de las 5 rutas que aplican dinero) en vez de enganchar esas
 * rutas: el aviso no puede romper un cobro, y un job que re-escanea es
 * idempotente por `dedupe_key`. Ventana de 24 h para que un backfill viejo o
 * un deploy tras días caídos no dispare cientos de avisos.
 *
 * Crédito / credit memo / store credit no son "dinero recibido" y se excluyen.
 */

import { publishNotification } from "../publish";
import type { Db, PublishResult } from "../types";

import { centsToUsd, customerLabel, methodLabel } from "./format";

export const PAYMENT_EXCLUDED_METHODS = ["credit", "credit_memo", "store_credit"];
export const PAYMENT_WINDOW_HOURS_DEFAULT = 24;

export interface PaymentApplicationRow {
  id: string;
  payment_id: string;
  invoice_id: string | null;
  invoice_number: string | null;
  order_id: string | null;
  amount_applied: string | number;
  applied_at: string | Date | null;
  method: string | null;
  payment_display_id: number | null;
  order_display_id: number | null;
  document_number: string | null;
  rep_initials: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export function paymentDedupeKey(applicationId: string): string {
  return `payment_applied:${applicationId}`;
}

export const PAYMENT_SCAN_SQL = `
  SELECT pa.id, pa.payment_id, pa.invoice_id, pa.invoice_number, pa.order_id,
         pa.amount_applied, pa.applied_at,
         cp.method, cp.display_id AS payment_display_id,
         o.display_id AS order_display_id,
         o.metadata->>'document_number' AS document_number,
         o.metadata->'sales_rep'->>'initials' AS rep_initials,
         c.company_name, c.first_name, c.last_name, COALESCE(c.email, o.email) AS email
    FROM payment_application pa
    JOIN customer_payment cp ON cp.id = pa.payment_id AND cp.deleted_at IS NULL
    LEFT JOIN "order" o ON o.id = pa.order_id
    LEFT JOIN customer c ON c.id = o.customer_id
   WHERE pa.deleted_at IS NULL
     AND pa.voided_at IS NULL
     AND pa.created_at > NOW() - ($1::int * INTERVAL '1 hour')
     AND (cp.method IS NULL OR NOT (cp.method = ANY($2::text[])))
     AND NOT EXISTS (
       SELECT 1 FROM pos_notification n WHERE n.dedupe_key = 'payment_applied:' || pa.id
     )
   ORDER BY pa.created_at ASC
   LIMIT 200`;

export function buildPaymentNotification(row: PaymentApplicationRow) {
  const amount = centsToUsd(row.amount_applied);
  const invoice = row.invoice_number ? ` · ${row.invoice_number}` : "";
  const orderLabel = row.document_number ?? (row.order_display_id ? `#${row.order_display_id}` : null);
  const bodyParts = [customerLabel(row)];
  if (orderLabel) bodyParts.push(`Order ${orderLabel}`);
  if (row.payment_display_id) bodyParts.push(`PAY-${row.payment_display_id}`);
  return {
    kind: "payment_received" as const,
    severity: "info" as const,
    title: `Payment received — ${amount} (${methodLabel(row.method)})${invoice}`,
    body: bodyParts.join(" · "),
    action_url: row.invoice_id ? `/invoices/${row.invoice_id}` : row.order_id ? `/orders/${row.order_id}` : null,
    entity_type: "payment_application",
    entity_id: row.id,
    payload: {
      payment_id: row.payment_id,
      invoice_id: row.invoice_id,
      order_id: row.order_id,
      amount_cents: Number.parseFloat(String(row.amount_applied)),
      method: row.method,
      rep_initials: row.rep_initials,
    },
    dedupe_key: paymentDedupeKey(row.id),
    occurred_at: row.applied_at,
    audiences: [{ kind: "admins" as const }, { kind: "rep" as const, initials: row.rep_initials }],
  };
}

export async function producePaymentNotifications(
  db: Db,
  opts: { windowHours?: number } = {}
): Promise<{ scanned: number; created: number; results: PublishResult[] }> {
  const { rows } = await db.query<PaymentApplicationRow>(PAYMENT_SCAN_SQL, [
    opts.windowHours ?? PAYMENT_WINDOW_HOURS_DEFAULT,
    PAYMENT_EXCLUDED_METHODS,
  ]);
  const results: PublishResult[] = [];
  for (const row of rows) {
    results.push(await publishNotification(db, buildPaymentNotification(row)));
  }
  return { scanned: rows.length, created: results.filter((r) => r.created).length, results };
}
