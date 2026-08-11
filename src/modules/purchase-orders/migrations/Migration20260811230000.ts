import { Migration } from "@mikro-orm/migrations";

/**
 * `purchase_order_receipt_line.purchase_order_line_id` and
 * `factory_order_receipt_line.factory_order_line_id` were ON DELETE CASCADE:
 * deleting a PO/FO line vaporized its receipt lines along with it, silently
 * wiping receipt history (and, if the receipt had no other lines left, the
 * whole receipt) instead of refusing the delete. Switch both to ON DELETE
 * RESTRICT — a line with receipt history now fails the delete at the DB
 * level; the API-level guard (`purchase-orders/[id]/route.ts`, code
 * `line_locked`) is what should catch it first with an actionable message.
 *
 * The receipt HEADER's own cascade to its lines is untouched on purpose —
 * deleting a receipt must still take its lines with it.
 *
 * Idempotent: checks pg_constraint before dropping/adding so a re-run (or a
 * partially-applied prior run) does not error.
 */
export class Migration20260811230000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from pg_constraint where conname = 'FK_porl_po_line_id'
        ) then
          alter table "purchase_order_receipt_line"
            drop constraint "FK_porl_po_line_id";
        end if;
        alter table "purchase_order_receipt_line"
          add constraint "FK_porl_po_line_id"
          foreign key ("purchase_order_line_id")
          references "purchase_order_line" ("id")
          on delete restrict;
      end $$;
    `);
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from pg_constraint where conname = 'FK_forl_fo_line_id'
        ) then
          alter table "factory_order_receipt_line"
            drop constraint "FK_forl_fo_line_id";
        end if;
        alter table "factory_order_receipt_line"
          add constraint "FK_forl_fo_line_id"
          foreign key ("factory_order_line_id")
          references "factory_order_line" ("id")
          on delete restrict;
      end $$;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from pg_constraint where conname = 'FK_porl_po_line_id'
        ) then
          alter table "purchase_order_receipt_line"
            drop constraint "FK_porl_po_line_id";
        end if;
        alter table "purchase_order_receipt_line"
          add constraint "FK_porl_po_line_id"
          foreign key ("purchase_order_line_id")
          references "purchase_order_line" ("id")
          on delete cascade;
      end $$;
    `);
    this.addSql(`
      do $$
      begin
        if exists (
          select 1 from pg_constraint where conname = 'FK_forl_fo_line_id'
        ) then
          alter table "factory_order_receipt_line"
            drop constraint "FK_forl_fo_line_id";
        end if;
        alter table "factory_order_receipt_line"
          add constraint "FK_forl_fo_line_id"
          foreign key ("factory_order_line_id")
          references "factory_order_line" ("id")
          on delete cascade;
      end $$;
    `);
  }
}
