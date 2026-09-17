/**
 * src/lib/notifications/inbox.ts
 *
 * Lo que la campana lee y escribe. TODAS las funciones reciben el `user_id`
 * que la ruta sacó del JWT: acá no hay forma de pedir la bandeja de otro.
 */

import type { Db, NotificationRow } from "./types";

export const INBOX_LIMIT_DEFAULT = 30;
export const INBOX_LIMIT_MAX = 100;

const ROW_SELECT = `
  SELECT n.id, n.kind, n.severity, n.title, n.body, n.action_url,
         n.entity_type, n.entity_id, n.payload, n.occurred_at, n.resolved_at,
         r.read_at
    FROM pos_notification_recipient r
    JOIN pos_notification n ON n.id = r.notification_id
   WHERE r.user_id = $1
     AND r.archived_at IS NULL
     AND (n.expires_at IS NULL OR n.expires_at > NOW())`;

export interface InboxQuery {
  user_id: string;
  unread_only: boolean;
  limit: number;
}

export function clampLimit(raw: unknown): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return INBOX_LIMIT_DEFAULT;
  return Math.min(n, INBOX_LIMIT_MAX);
}

export async function listInbox(db: Db, q: InboxQuery): Promise<NotificationRow[]> {
  const unreadClause = q.unread_only ? "AND r.read_at IS NULL AND n.resolved_at IS NULL" : "";
  const { rows } = await db.query<NotificationRow>(
    `${ROW_SELECT} ${unreadClause}
     ORDER BY n.occurred_at DESC, n.id DESC
     LIMIT $2`,
    [q.user_id, q.limit]
  );
  return rows;
}

/** No leídas y no resueltas: es el número del badge. */
export async function countUnread(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM pos_notification_recipient r
       JOIN pos_notification n ON n.id = r.notification_id
      WHERE r.user_id = $1 AND r.read_at IS NULL AND r.archived_at IS NULL
        AND n.resolved_at IS NULL
        AND (n.expires_at IS NULL OR n.expires_at > NOW())`,
    [userId]
  );
  return Number.parseInt(rows[0]?.n ?? "0", 10);
}

/** true ⇒ era suya y quedó leída (o ya lo estaba). false ⇒ no es suya. */
export async function markRead(db: Db, userId: string, notificationId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE pos_notification_recipient
        SET read_at = COALESCE(read_at, NOW())
      WHERE user_id = $1 AND notification_id = $2`,
    [userId, notificationId]
  );
  return (rowCount ?? 0) > 0;
}

export async function markAllRead(db: Db, userId: string): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE pos_notification_recipient
        SET read_at = NOW()
      WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL`,
    [userId]
  );
  return rowCount ?? 0;
}
