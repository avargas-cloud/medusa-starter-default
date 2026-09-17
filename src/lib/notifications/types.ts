/**
 * src/lib/notifications/types.ts
 *
 * Contrato de la bandeja de notificaciones del POS (campana del TopBar).
 * Productores → `publishNotification` → tablas `pos_notification` +
 * `pos_notification_recipient` → `GET /admin/pos/notifications` (polling).
 */

import type { Pool, PoolClient } from "pg";

/** Un pool o un cliente dentro de una transacción: todo acá usa `$1`. */
export type Db = Pool | PoolClient;

export const NOTIFICATION_KINDS = [
  "payment_received",
  "po_due_today",
  "web_order_placed",
  "qb_pipeline_failed",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * A quién va. Se EXPANDE a `user_id`s concretos al publicar (lib/recipients),
 * nunca se guarda el rol: si mañana alguien deja de ser admin, lo que ya
 * recibió sigue siendo suyo y lo nuevo ya no le llega.
 */
export type Audience =
  | { kind: "all" }
  | { kind: "admins" }
  | { kind: "owner" }
  | { kind: "accounting" }
  | { kind: "users"; user_ids: string[] }
  /** El rep de una orden, por initials (`order.metadata.sales_rep.initials`). */
  | { kind: "rep"; initials: string | null | undefined };

export interface NotificationInput {
  kind: NotificationKind;
  severity?: NotificationSeverity;
  title: string;
  body?: string | null;
  /** Ruta del POS a la que navega el click (`/orders/ord_…`). */
  action_url?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  /** Chico: ids y resumen, nunca documentos enteros. */
  payload?: Record<string, unknown>;
  /** Idempotencia. Mismo hecho ⇒ misma clave ⇒ una sola fila, siempre. */
  dedupe_key: string;
  occurred_at?: Date | string | null;
  expires_at?: Date | string | null;
  audiences: Audience[];
}

export interface PublishResult {
  /** false ⇒ ya existía (dedupe) y no se tocó nada. */
  created: boolean;
  notification_id: string | null;
  recipient_user_ids: string[];
}

/** Lo que ve el cliente en el panel. */
export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  action_url: string | null;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  resolved_at: string | null;
  read_at: string | null;
}
