import { MigrationInterface, QueryRunner } from "typeorm";

export class AddNextPayloadToQbPipeline1776100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE qb_order_pipeline
        ADD COLUMN IF NOT EXISTS next_payload JSONB DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE qb_order_pipeline
        DROP COLUMN IF EXISTS next_payload
    `);
  }
}
