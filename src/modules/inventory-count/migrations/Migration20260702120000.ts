import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260702120000
 *
 * Phase 1 of the "robust counting" rework: split the single counted quantity
 * into an on-hand (floor) component and a reserved ("apartados"/holding-area)
 * component so the clerk can never silently skip the reserved shelf.
 *
 *   qty_counted_available    — units counted on the sales floor (≈ available)
 *   qty_counted_reserved   — units counted in the reserved/holding area (≈ reserved)
 *   reserved_at_count_time — system reserved_quantity snapshotted at submit
 *
 * qty_counted stays the TOTAL (= on_hand + reserved) and remains the source of
 * truth for the delta math; these columns are additive and nullable.
 */
export class Migration20260702120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         add column if not exists "qty_counted_available" integer null,
         add column if not exists "qty_counted_reserved" integer null,
         add column if not exists "reserved_at_count_time" integer null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         drop column if exists "qty_counted_available",
         drop column if exists "qty_counted_reserved",
         drop column if exists "reserved_at_count_time";`
    );
  }
}
