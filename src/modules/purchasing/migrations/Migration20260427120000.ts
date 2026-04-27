import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260427120000
 *
 * Adds alt-aware supply columns to purchasing_snapshot:
 *   - inv_china_alt:        sum of inv_china across the variant's alternatives
 *   - qty_on_po_china_alt:  sum of qty_on_po_china across alternatives (factory POs)
 *
 * These let the qty_to_factory calculation subtract the FULL effective supply
 * pool (own inventory + alt inventory + own factory POs + alt factory POs)
 * before deciding how much to ask the factory to produce.
 */
export class Migration20260427120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchasing_snapshot"
      ADD COLUMN IF NOT EXISTS "inv_china_alt" int NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "qty_on_po_china_alt" int NOT NULL DEFAULT 0;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchasing_snapshot"
      DROP COLUMN IF EXISTS "inv_china_alt",
      DROP COLUMN IF EXISTS "qty_on_po_china_alt";
    `);
  }
}
