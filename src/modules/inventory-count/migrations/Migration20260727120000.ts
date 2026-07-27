import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Preserve both reservation views used by inventory counts:
 * - reserved_at_count_time: raw Medusa allocation cache (audit)
 * - effective_reserved_at_count_time: physical reserved-rack baseline, capped
 *   at total on-hand
 *
 * Reservation movements can change which rack must be counted even when total
 * on-hand stays unchanged, so the recount trigger also watches the effective
 * reserved value.
 */
export class Migration20260727120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         add column if not exists "effective_reserved_at_count_time" integer null;`
    );

    this.addSql(
      `drop trigger if exists trg_inventory_count_recount_flag on inventory_level;`
    );
    this.addSql(`
      create trigger trg_inventory_count_recount_flag
        after update of stocked_quantity, reserved_quantity on inventory_level
        for each row
        when (
          OLD.stocked_quantity is distinct from NEW.stocked_quantity
          or least(
            greatest(OLD.reserved_quantity, 0),
            greatest(OLD.stocked_quantity, 0)
          ) is distinct from least(
            greatest(NEW.reserved_quantity, 0),
            greatest(NEW.stocked_quantity, 0)
          )
        )
        execute function inventory_count_flag_recount();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop trigger if exists trg_inventory_count_recount_flag on inventory_level;`
    );
    this.addSql(`
      create trigger trg_inventory_count_recount_flag
        after update of stocked_quantity on inventory_level
        for each row
        when (OLD.stocked_quantity is distinct from NEW.stocked_quantity)
        execute function inventory_count_flag_recount();
    `);
    this.addSql(
      `alter table "inventory_count_line"
         drop column if exists "effective_reserved_at_count_time";`
    );
  }
}
