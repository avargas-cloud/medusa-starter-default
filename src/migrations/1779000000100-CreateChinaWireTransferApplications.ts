import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateChinaWireTransferApplications1779000000100
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS china_wire_transfer_application (
        id                TEXT PRIMARY KEY,
        wire_transfer_id  TEXT NOT NULL REFERENCES china_wire_transfer(id) ON DELETE CASCADE,
        bill_id           TEXT NOT NULL REFERENCES china_finance_bill(id) ON DELETE CASCADE,
        applied_cents     INTEGER NOT NULL DEFAULT 0,
        sort_order        INTEGER NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cwta_wire_transfer_id
        ON china_wire_transfer_application(wire_transfer_id)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_cwta_bill_id
        ON china_wire_transfer_application(bill_id)
    `);

    await queryRunner.query(`
      INSERT INTO china_wire_transfer_application
        (id, wire_transfer_id, bill_id, applied_cents, sort_order)
      SELECT
        gen_random_uuid()::text,
        cfb.wire_transfer_id,
        cfb.id,
        cfb.amount_cents,
        cfb.sort_order
      FROM china_finance_bill cfb
      WHERE cfb.wire_transfer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM china_wire_transfer_application cwta
          WHERE cwta.bill_id = cfb.id
            AND cwta.wire_transfer_id = cfb.wire_transfer_id
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS china_wire_transfer_application`);
  }
}
