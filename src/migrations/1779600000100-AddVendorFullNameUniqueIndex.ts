import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Vendor create dedup (Phase 3). The route already does a check-then-insert on
 * full_name, but with only a NON-unique index (IDX_qb_vendor_full_name) there's
 * a race window where two concurrent creates both pass the check and insert a
 * duplicate. A real UNIQUE index closes that window (the second INSERT fails on
 * the constraint instead of silently duplicating).
 *
 * This complements the generic Idempotency-Key middleware: the middleware stops
 * a SAME-key double-submit; the unique index stops two DIFFERENT intents that
 * happen to name the same vendor. Preflight confirmed zero live duplicates.
 */
export class AddVendorFullNameUniqueIndex1779600000100
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Replace the redundant non-unique partial index with a UNIQUE one.
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_qb_vendor_full_name";`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_vendor_full_name_live
        ON qb_vendor (full_name)
        WHERE deleted_at IS NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_qb_vendor_full_name_live;`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_qb_vendor_full_name"
        ON qb_vendor (full_name)
        WHERE deleted_at IS NULL;
    `);
  }
}
