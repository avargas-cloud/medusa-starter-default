import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260418220000
 *
 * Adds the `verified` line status. A `verified` line was counted by the
 * cashier and matched the system stock exactly (delta = 0). It IS persisted
 * for audit but is NOT applied to inventory_levels and NOT pushed to QB —
 * QB only receives lines with non-zero quantity differences.
 */
export class Migration20260418220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line" drop constraint if exists "inventory_count_line_status_check";`
    );
    this.addSql(
      `alter table "inventory_count_line" add constraint "inventory_count_line_status_check" check ("status" in ('pending','applied','blocked','skipped','overridden','verified'));`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line" drop constraint if exists "inventory_count_line_status_check";`
    );
    this.addSql(
      `alter table "inventory_count_line" add constraint "inventory_count_line_status_check" check ("status" in ('pending','applied','blocked','skipped','overridden'));`
    );
  }
}
