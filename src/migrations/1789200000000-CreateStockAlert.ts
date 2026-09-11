import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Alertas "avisame cuando vuelva el stock" pedidas desde el BOM de las apps
 * embebidas en la web (user-stated 2026-09-11). Expand-only. Una alerta
 * PENDIENTE por (cliente, variante) — índice único parcial; las notificadas o
 * canceladas quedan como historial y permiten volver a pedir.
 */
export class CreateStockAlert1789200000000 implements MigrationInterface {
  name = "CreateStockAlert1789200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS stock_alert (
        id           TEXT        PRIMARY KEY,
        customer_id  TEXT        NOT NULL,
        email        TEXT        NOT NULL,
        variant_id   TEXT        NOT NULL,
        sku          TEXT        NOT NULL,
        source_app   TEXT        NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        notified_at  TIMESTAMPTZ NULL,
        canceled_at  TIMESTAMPTZ NULL
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS stock_alert_pending_uq
        ON stock_alert (customer_id, variant_id)
        WHERE notified_at IS NULL AND canceled_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS stock_alert_pending_variant_idx
        ON stock_alert (variant_id)
        WHERE notified_at IS NULL AND canceled_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS stock_alert`);
  }
}
