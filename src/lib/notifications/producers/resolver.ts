/**
 * Huérfanas: la causa dejó de existir → `resolved_at`. Cada regla se acota por
 * `kind`: dos kinds pueden compartir `entity_type` (pago recibido y refund
 * pendiente apuntan al mismo customer_payment) y una regla sin kind resolvió
 * 9 avisos de pago en el sandbox. No borra (historial), y
 * el panel deja de mostrarlas como pendientes. Corre por job; no se engancha a
 * ninguna ruta de cancel/void — esas rutas son de dinero y no se tocan.
 *
 *   · order canceled            → web_order_placed / order_separable / estimate_stale
 *   · estimate convertido       → estimate_stale (ya no es draft)
 *   · pago anulado / aplicación void → payment_received
 *   · fila QB ya no en failed   → qb_pipeline_failed
 *   · pendientes resueltos      → commission_request / price_batch / refund
 */

import type { Db } from "../types";
import { SALES_SQL } from "../../quickbooks/pipeline-status";

const RULES: Array<{ name: string; sql: string }> = [
  {
    name: "order_canceled",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM "order" o
           WHERE n.resolved_at IS NULL AND n.kind IN ('web_order_placed','order_separable','estimate_stale') AND n.entity_type = 'order' AND o.id = n.entity_id
             AND (o.status = 'canceled' OR o.canceled_at IS NOT NULL OR o.deleted_at IS NOT NULL)`,
  },
  {
    name: "estimate_converted_or_closed",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM "order" o
           WHERE n.resolved_at IS NULL AND n.kind = 'estimate_stale' AND o.id = n.entity_id
             AND (o.status <> 'draft' OR o.is_draft_order = false
                  OR lower(COALESCE(o.metadata->>'order_status', o.metadata->>'estimate_status', '')) NOT IN ('sent by email','provided in store'))`,
  },
  {
    name: "payment_application_voided",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM payment_application pa
           WHERE n.resolved_at IS NULL AND n.kind = 'payment_received' AND n.entity_type = 'payment_application' AND pa.id = n.entity_id
             AND (pa.voided_at IS NOT NULL OR pa.deleted_at IS NOT NULL)`,
  },
  {
    // Avisos de pago keyeados por PAGO (desde fase 2): el pago se anuló.
    name: "payment_voided",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM customer_payment cp
           WHERE n.resolved_at IS NULL AND n.kind = 'payment_received' AND n.entity_type = 'customer_payment'
             AND cp.id = n.entity_id AND (cp.status = 'voided' OR cp.deleted_at IS NOT NULL)`, // entity-status
  },
  {
    name: "qb_row_recovered",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM qb_order_pipeline p
           WHERE n.resolved_at IS NULL AND n.kind = 'qb_pipeline_failed' AND n.entity_type = 'qb_order_pipeline' AND p.id::text = n.entity_id
             AND p.status NOT IN (${SALES_SQL.failed})`,
  },
  {
    name: "commission_request_reviewed",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM commission_request cr
           WHERE n.resolved_at IS NULL AND n.kind = 'commission_request_pending' AND cr.id = n.entity_id
             AND (cr.status <> 'pending' OR cr.deleted_at IS NOT NULL)`, // entity-status
  },
  {
    name: "price_batch_reviewed",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM price_change_batch b
           WHERE n.resolved_at IS NULL AND n.kind = 'price_batch_submitted' AND b.id = n.entity_id
             AND (b.status <> 'submitted' OR b.deleted_at IS NOT NULL)`, // entity-status
  },
  {
    name: "refund_settled",
    sql: `UPDATE pos_notification n SET resolved_at = NOW(), updated_at = NOW()
            FROM customer_payment cp
           WHERE n.resolved_at IS NULL AND n.kind = 'refund_pending' AND cp.id = n.entity_id
             AND (cp.status NOT IN ('refunded','partial_refunded') OR cp.deleted_at IS NOT NULL)`,
  },
];

export async function resolveOrphanNotifications(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const rule of RULES) {
    const { rowCount } = await db.query(rule.sql);
    out[rule.name] = rowCount ?? 0;
  }
  return out;
}
