import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThumbnailToProductCategory1737526800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Raw SQL for idempotency — safe to re-run when tracking table is initialized fresh
    await queryRunner.query(
      `ALTER TABLE product_category ADD COLUMN IF NOT EXISTS thumbnail TEXT`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE product_category DROP COLUMN IF EXISTS thumbnail`
    );
  }
}
