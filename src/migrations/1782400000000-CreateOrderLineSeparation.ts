import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-line separation quantities for an order — replaces the all-or-nothing
 * `order.metadata.is_separated` boolean as the source of truth.
 *
 * "Separated" is an OPERATIONAL mark (warehouse staff physically set units
 * aside for the order). It never moves stock or reservations — the cap against
 * physical Miami inventory is enforced by the write route, not by this table.
 *
 * One row per (order_id, order_line_item_id), upserted with the current
 * separated quantity. `metadata.is_separated` stays derived (true only when
 * every open line is fully separated) so the Separated tab and Meili keep
 * working; `metadata.separation_status` carries the tri-state.
 */
export class CreateOrderLineSeparation1782400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_line_separation (
        id                 bigserial   PRIMARY KEY,
        order_id           text        NOT NULL,
        order_line_item_id text        NOT NULL,
        qty                numeric     NOT NULL,
        updated_by         text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_at         timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "CHK_order_line_separation_qty"
          CHECK (qty >= 0),
        CONSTRAINT "UQ_order_line_separation_line"
          UNIQUE (order_id, order_line_item_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_line_separation_order"
        ON order_line_separation (order_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS order_line_separation`);
  }
}
