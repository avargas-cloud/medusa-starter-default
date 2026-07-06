import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * China Adjustment — void support.
 *
 * Adds terminal void columns so a mistaken China inventory adjustment can be
 * reversed: the void reverses each line's net `delta` on live stock
 * (movement-invariant) and stamps who/when/why. `voided_at IS NULL` = active.
 *
 * Purely additive (nullable columns; existing rows stay active).
 */
export class AddVoidColumnsToChinaAdjustment1779900000000
  implements MigrationInterface
{
  name = "AddVoidColumnsToChinaAdjustment1779900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE china_adjustment
         ADD COLUMN IF NOT EXISTS voided_at timestamptz,
         ADD COLUMN IF NOT EXISTS voided_by_user_id text,
         ADD COLUMN IF NOT EXISTS void_reason text`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE china_adjustment
         DROP COLUMN IF EXISTS voided_at,
         DROP COLUMN IF EXISTS voided_by_user_id,
         DROP COLUMN IF EXISTS void_reason`
    );
  }
}
