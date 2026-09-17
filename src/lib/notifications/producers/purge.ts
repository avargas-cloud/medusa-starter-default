/**
 * Envejecimiento de la bandeja (job diario). Estándar de las bandejas de
 * notificaciones: lo LEÍDO o RESUELTO envejece y sale solo; lo NO LEÍDO nunca
 * se toca — un aviso que nadie vio no se pierde por calendario.
 *
 *   · leída o resuelta hace > ARCHIVE_AFTER_DAYS  → `archived_at` (sale del panel)
 *   · aviso creado hace > DELETE_AFTER_DAYS         → se borra (con sus recipients,
 *     ON DELETE CASCADE), SÓLO si no le queda ningún destinatario sin leer
 */

import type { Db } from "../types";

export const ARCHIVE_AFTER_DAYS = 30;
export const DELETE_AFTER_DAYS = 180;

export async function purgeNotifications(
  db: Db,
  opts: { archiveAfterDays?: number; deleteAfterDays?: number } = {}
): Promise<{ archived: number; deleted: number }> {
  const archiveDays = opts.archiveAfterDays ?? ARCHIVE_AFTER_DAYS;
  const deleteDays = opts.deleteAfterDays ?? DELETE_AFTER_DAYS;
  const archived = await db.query(
    `UPDATE pos_notification_recipient r
        SET archived_at = NOW()
       FROM pos_notification n
      WHERE n.id = r.notification_id
        AND r.archived_at IS NULL
        AND (
          r.read_at < NOW() - ($1::int * INTERVAL '1 day')
          OR n.resolved_at < NOW() - ($1::int * INTERVAL '1 day')
        )`,
    [archiveDays]
  );
  const deleted = await db.query(
    `DELETE FROM pos_notification n
      WHERE n.created_at < NOW() - ($1::int * INTERVAL '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM pos_notification_recipient r
           WHERE r.notification_id = n.id AND r.read_at IS NULL AND r.archived_at IS NULL
        )`,
    [deleteDays]
  );
  return { archived: archived.rowCount ?? 0, deleted: deleted.rowCount ?? 0 };
}
