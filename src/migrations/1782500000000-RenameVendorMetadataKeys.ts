import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Rename the product vendor metadata pair, EXPAND half:
 *
 *   qb_vendor_full_name → vendor_full_name
 *   qb_vendor_list_id   → vendor_list_id
 *
 * This COPIES the values under their new names and deliberately LEAVES the old
 * keys in place. Railway runs migrations in predeploy, so for the 5-8 minutes
 * until the new build is ACTIVE the previous one is still serving traffic and
 * still reads `qb_vendor_*`. A rename that dropped the old keys would blank the
 * vendor on six report routes and on the /inventory Edit Item modal for the
 * whole cutover — and an edit saved in that window would persist the blank.
 *
 * Dropping the legacy keys is a separate, later migration. Do not add it here:
 * it must not run in the same predeploy as the code that stops writing them.
 *
 * Idempotent: re-running is a no-op because the WHERE clause excludes rows that
 * already carry the new key with the same value. Safe to re-run after a partial
 * failure — it is batched per table, not one long transaction.
 *
 * Scope: `product` (2.208 rows carry the name, 2.205 the list id) and
 * `product_variant` (45 / 2.488). Touches no other table and no other key: the
 * `||` operator merges into the existing JSONB rather than replacing it.
 */
export class RenameVendorMetadataKeys1782500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ["product", "product_variant"]) {
      // Name and list id are copied in separate statements on purpose: a row
      // can legitimately carry one without the other (3 products have the name
      // and no list id), and a combined jsonb_build_object would write a null
      // for the missing half — turning "absent" into "explicitly empty".
      //
      // `metadata->'k' IS NOT NULL` rather than the jsonb `?` operator: `?` is
      // a bind placeholder to several drivers in this codebase, and a key
      // holding a JSON null should be skipped here anyway.
      await queryRunner.query(`
        UPDATE "${table}"
           SET metadata = metadata || jsonb_build_object(
                 'vendor_full_name', metadata->>'qb_vendor_full_name')
         WHERE metadata->'qb_vendor_full_name' IS NOT NULL
           AND (metadata->>'vendor_full_name') IS DISTINCT FROM (metadata->>'qb_vendor_full_name');
      `);

      await queryRunner.query(`
        UPDATE "${table}"
           SET metadata = metadata || jsonb_build_object(
                 'vendor_list_id', metadata->>'qb_vendor_list_id')
         WHERE metadata->'qb_vendor_list_id' IS NOT NULL
           AND (metadata->>'vendor_list_id') IS DISTINCT FROM (metadata->>'qb_vendor_list_id');
      `);
    }
  }

  /**
   * Removes ONLY the new keys. The legacy ones were never touched by `up`, so
   * after this the data is byte-for-byte what it was before the migration ran.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ["product", "product_variant"]) {
      await queryRunner.query(`
        UPDATE "${table}"
           SET metadata = metadata - 'vendor_full_name' - 'vendor_list_id'
         WHERE metadata->'vendor_full_name' IS NOT NULL
            OR metadata->'vendor_list_id' IS NOT NULL;
      `);
    }
  }
}
