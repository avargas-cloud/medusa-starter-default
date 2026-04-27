import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260427000000
 *
 * Adds first_sale_date to purchasing_snapshot. Used by the Daily Sales Engine
 * to skip pre-life quarters (no product yet) and partial-prorate the birth
 * quarter so days before the first sale are excluded from the denominator.
 */
export class Migration20260427000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchasing_snapshot"
      ADD COLUMN IF NOT EXISTS "first_sale_date" date NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchasing_snapshot"
      DROP COLUMN IF EXISTS "first_sale_date";
    `);
  }
}
