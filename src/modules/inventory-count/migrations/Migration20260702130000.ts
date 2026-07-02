import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260702130000
 *
 * Phase 2 of the "robust counting" rework: detect stock movement DURING an open
 * draft so a counted line whose stock changed (e.g. a sale shipped mid-count)
 * is flagged for re-count and blocks submit — instead of silently producing a
 * wrong delta against a stale baseline.
 *
 * Columns:
 *   counted_at             — when the clerk last committed a count for the line
 *   stocked_at_count       — live stocked_quantity snapshotted at that moment
 *   needs_recount          — set true by the trigger when stock moved after count
 *   stock_moved_at         — when the movement was detected
 *   stocked_after_movement — the new stocked_quantity at movement time
 *
 * Trigger `trg_inventory_count_recount_flag` on `inventory_level`: whenever
 * stocked_quantity changes, it flags every ALREADY-COUNTED, not-yet-stale line
 * of an OPEN DRAFT count for that (inventory_item, location). Uses a Postgres
 * trigger (not a Medusa subscriber) so it catches EVERY movement source — POS
 * sales, PO receipts, transfers, raw SQL, fix scripts — the same rationale as
 * the existing Meili-sync trigger on this table.
 */
export class Migration20260702130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         add column if not exists "counted_at" timestamptz null,
         add column if not exists "stocked_at_count" integer null,
         add column if not exists "needs_recount" boolean not null default false,
         add column if not exists "stock_moved_at" timestamptz null,
         add column if not exists "stocked_after_movement" integer null;`
    );

    // Partial index keeps the trigger's UPDATE cheap: only counted, non-stale,
    // live lines are candidates.
    this.addSql(
      `create index if not exists "IDX_icl_recount_candidates"
         on "inventory_count_line" ("inventory_item_id")
         where "qty_counted" is not null
           and "needs_recount" = false
           and "deleted_at" is null;`
    );

    this.addSql(`
      create or replace function inventory_count_flag_recount()
      returns trigger
      language plpgsql
      as $$
      begin
        update inventory_count_line icl
          set needs_recount = true,
              stock_moved_at = now(),
              stocked_after_movement = NEW.stocked_quantity
          from inventory_count ic
          where icl.inventory_count_id = ic.id
            and ic.status = 'draft'
            and ic.deleted_at is null
            and ic.stock_location_id = NEW.location_id
            and icl.inventory_item_id = NEW.inventory_item_id
            and icl.qty_counted is not null
            and icl.needs_recount = false
            and icl.deleted_at is null;
        return NEW;
      end;
      $$;
    `);

    this.addSql(`drop trigger if exists trg_inventory_count_recount_flag on inventory_level;`);
    this.addSql(`
      create trigger trg_inventory_count_recount_flag
        after update of stocked_quantity on inventory_level
        for each row
        when (OLD.stocked_quantity is distinct from NEW.stocked_quantity)
        execute function inventory_count_flag_recount();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists trg_inventory_count_recount_flag on inventory_level;`);
    this.addSql(`drop function if exists inventory_count_flag_recount();`);
    this.addSql(`drop index if exists "IDX_icl_recount_candidates";`);
    this.addSql(
      `alter table "inventory_count_line"
         drop column if exists "counted_at",
         drop column if exists "stocked_at_count",
         drop column if exists "needs_recount",
         drop column if exists "stock_moved_at",
         drop column if exists "stocked_after_movement";`
    );
  }
}
