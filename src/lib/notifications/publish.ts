/**
 * src/lib/notifications/publish.ts
 *
 * El ÚNICO camino para crear una notificación. `INSERT … ON CONFLICT
 * (dedupe_key) DO NOTHING` es la idempotencia: un job que re-escanea, un
 * subscriber que Medusa reintenta, o dos instancias de Railway a la vez
 * producen UNA fila. Los destinatarios se insertan sólo cuando la
 * notificación nació acá; si ya existía, no se toca (ni se re-marca no-leída).
 *
 * Nunca lanza hacia el productor por un fallo de destinatarios: una campana
 * sin destinatario es un aviso perdido, no un pago perdido — el productor
 * loguea y sigue.
 */

import { randomUUID } from "node:crypto";

import { resolveRecipients } from "./recipients";
import type { Db, NotificationInput, PublishResult } from "./types";

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function publishNotification(
  db: Db,
  input: NotificationInput
): Promise<PublishResult> {
  if (!input.dedupe_key || !input.title || !input.kind) {
    throw new Error("publishNotification: kind, title y dedupe_key son obligatorios");
  }
  const recipients = await resolveRecipients(db, input.audiences);
  if (recipients.length === 0) {
    return { created: false, notification_id: null, recipient_user_ids: [] };
  }

  const id = `posn_${randomUUID()}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO pos_notification
       (id, kind, severity, title, body, action_url, entity_type, entity_id,
        payload, dedupe_key, occurred_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10,
             COALESCE($11::timestamptz, NOW()), $12::timestamptz)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [
      id,
      input.kind,
      input.severity ?? "info",
      input.title,
      input.body ?? null,
      input.action_url ?? null,
      input.entity_type ?? null,
      input.entity_id ?? null,
      JSON.stringify(input.payload ?? {}),
      input.dedupe_key,
      toIso(input.occurred_at),
      toIso(input.expires_at),
    ]
  );
  const inserted = rows[0]?.id;
  if (!inserted) {
    return { created: false, notification_id: null, recipient_user_ids: [] };
  }

  const values: string[] = [];
  const params: string[] = [];
  recipients.forEach((userId, i) => {
    const base = i * 3;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    params.push(`posnr_${randomUUID()}`, inserted, userId);
  });
  await db.query(
    `INSERT INTO pos_notification_recipient (id, notification_id, user_id)
     VALUES ${values.join(", ")}
     ON CONFLICT (notification_id, user_id) DO NOTHING`,
    params
  );
  return { created: true, notification_id: inserted, recipient_user_ids: recipients };
}

/**
 * La causa dejó de existir (orden cancelada, fila QB confirmada). No borra:
 * la fila queda como historial, y el panel deja de mostrarla como pendiente.
 */
export async function resolveNotificationsByEntity(
  db: Db,
  entityType: string,
  entityId: string
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE pos_notification
        SET resolved_at = NOW(), updated_at = NOW()
      WHERE entity_type = $1 AND entity_id = $2 AND resolved_at IS NULL`,
    [entityType, entityId]
  );
  return rowCount ?? 0;
}
