import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260426000000
 *
 * Adds sales_last_24d column to purchasing_snapshot.
 * Stores raw units sold in the last 28 calendar days (≈4 Mon-Sat weeks).
 * Used exclusively as an informational "Transfer Last 4W" column in the POS.
 */
export class Migration20260426000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchasing_snapshot"
      ADD COLUMN IF NOT EXISTS "sales_last_24d" numeric NOT NULL DEFAULT 0;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchasing_snapshot"
      DROP COLUMN IF EXISTS "sales_last_24d";
    `);
  }
}
