import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260812000000
 *
 * XYZ class 'N' (new / insufficient history). A SKU with fewer than 3 months
 * in its CV series has variance 0 by construction, so it used to claim 'X'
 * ("stable demand") with zero evidence — 17 SKUs at the time of this change.
 *
 * - Widens the xyz_class CHECK to accept 'N'.
 * - Adds cv_points (months actually in the CV series) so the frontend can
 *   flag 3-5 point classifications as provisional.
 */
export class Migration20260812000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "purchasing_snapshot"
        drop constraint if exists "purchasing_snapshot_xyz_class_check";
    `);
    this.addSql(`
      alter table "purchasing_snapshot"
        add constraint "purchasing_snapshot_xyz_class_check"
        check ("xyz_class" in ('X','Y','Z','N'));
    `);
    this.addSql(`
      alter table "purchasing_snapshot"
        add column if not exists "cv_points" integer null;
    `);
  }

  override async down(): Promise<void> {
    // Rows already classified 'N' would violate the narrow CHECK — clear them
    // first so the rollback cannot strand the table in an invalid state.
    this.addSql(`
      update "purchasing_snapshot"
        set "xyz_class" = null,
            "abcxyz_class" = null
        where "xyz_class" = 'N';
    `);
    this.addSql(`
      alter table "purchasing_snapshot"
        drop constraint if exists "purchasing_snapshot_xyz_class_check";
    `);
    this.addSql(`
      alter table "purchasing_snapshot"
        add constraint "purchasing_snapshot_xyz_class_check"
        check ("xyz_class" in ('X','Y','Z'));
    `);
    this.addSql(`
      alter table "purchasing_snapshot" drop column if exists "cv_points";
    `);
  }
}
