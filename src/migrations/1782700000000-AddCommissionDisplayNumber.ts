import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Sequential, gapless, human-readable number for order commissions: COM-####.
 *
 * The number lives on `order_commission` (the per-order commission document),
 * NOT on the recipient rows — a re-save of the assignment soft-deletes and
 * re-inserts every recipient, so a per-recipient number would churn on every
 * save and burn counter values. Recipients are distinguished by their ordinal
 * (same convention as the RC-<order>-<ordinal> check RefNumber).
 *
 * Counter row in `document_number_counter` (name 'order_commission', seeded at
 * 1000 so the first allocation is 1001), claimed with UPDATE ... RETURNING
 * inside the creating transaction — same pattern as price_change_batch.
 *
 * Idempotent: ADD COLUMN IF NOT EXISTS, ON CONFLICT DO NOTHING on the seed,
 * and the backfill only touches rows with display_number IS NULL.
 */
export class AddCommissionDisplayNumber1782700000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_commission
        ADD COLUMN IF NOT EXISTS display_number bigint
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_order_commission_display_number
        ON order_commission (display_number)
    `);
    await queryRunner.query(`
      INSERT INTO document_number_counter (name, value)
      VALUES ('order_commission', 1000)
      ON CONFLICT (name) DO NOTHING
    `);
    // Backfill existing commissions (soft-deleted included — the unique index
    // covers every row) in creation order, and advance the counter past them
    // in the same statement batch so new allocations never collide.
    await queryRunner.query(`
      WITH numbered AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY created_at, id)
                 + (SELECT value FROM document_number_counter
                     WHERE name = 'order_commission') AS n
          FROM order_commission
         WHERE display_number IS NULL
      ),
      applied AS (
        UPDATE order_commission oc
           SET display_number = numbered.n
          FROM numbered
         WHERE oc.id = numbered.id
        RETURNING numbered.n
      )
      UPDATE document_number_counter
         SET value = GREATEST(value, (SELECT COALESCE(MAX(n), 0) FROM applied)),
             updated_at = now()
       WHERE name = 'order_commission'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_order_commission_display_number`
    );
    await queryRunner.query(
      `ALTER TABLE order_commission DROP COLUMN IF EXISTS display_number`
    );
    await queryRunner.query(
      `DELETE FROM document_number_counter WHERE name = 'order_commission'`
    );
  }
}
