import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pos-notifications-20260917: bandeja de notificaciones in-app del POS (la
 * campana del TopBar). Dos tablas, no una: el título/cuerpo/payload viven una
 * sola vez en `pos_notification`; quién la vio vive por persona en
 * `pos_notification_recipient`. Así "resolver" (la causa dejó de existir) es
 * un UPDATE de una fila, y el mismo aviso llega a admin + rep sin duplicarse.
 *
 * `dedupe_key` UNIQUE es la idempotencia: los productores son jobs que
 * re-escanean, así que el mismo hecho (mismo pago, mismo PO el mismo día,
 * la misma fila QB con el mismo error) sólo puede nacer una vez.
 *
 * No hay módulo Medusa: mismo patrón que `commission_request` — migración raw
 * + `lib/notifications/`. Aditiva: no toca ninguna tabla existente.
 */
export class PosNotifications20260917140001 implements MigrationInterface {
  name = "PosNotifications20260917140001";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS pos_notification (
        id            text PRIMARY KEY,
        kind          text NOT NULL,
        severity      text NOT NULL DEFAULT 'info',
        title         text NOT NULL,
        body          text NULL,
        action_url    text NULL,
        entity_type   text NULL,
        entity_id     text NULL,
        payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
        dedupe_key    text NOT NULL,
        occurred_at   timestamptz NOT NULL DEFAULT NOW(),
        resolved_at   timestamptz NULL,
        expires_at    timestamptz NULL,
        created_at    timestamptz NOT NULL DEFAULT NOW(),
        updated_at    timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_posn_severity CHECK (severity IN ('info','warning','critical')),
        CONSTRAINT uq_posn_dedupe UNIQUE (dedupe_key)
      )
    `);
    await q.query(`
      CREATE TABLE IF NOT EXISTS pos_notification_recipient (
        id               text PRIMARY KEY,
        notification_id  text NOT NULL REFERENCES pos_notification(id) ON DELETE CASCADE,
        user_id          text NOT NULL,
        read_at          timestamptz NULL,
        archived_at      timestamptz NULL,
        created_at       timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_posnr_notification_user UNIQUE (notification_id, user_id)
      )
    `);
    // La query de la campana: "mis no leídas, más nuevas primero".
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_posnr_user_unread
        ON pos_notification_recipient (user_id, created_at DESC)
        WHERE read_at IS NULL AND archived_at IS NULL
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_posnr_user_all
        ON pos_notification_recipient (user_id, created_at DESC)
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_posn_entity
        ON pos_notification (entity_type, entity_id)
        WHERE resolved_at IS NULL
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS pos_notification_recipient`);
    await q.query(`DROP TABLE IF EXISTS pos_notification`);
  }
}
