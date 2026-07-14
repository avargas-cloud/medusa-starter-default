import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260714170000
 *
 * Widens order_delivery_provider_check to allow 'manual' — a tracking number
 * typed by hand into TrackingModal (no label bought, no dispatch adapter)
 * needs its own order_delivery row so the order shows up in the [Deliveries]
 * tab, which reads exclusively from this table.
 */
export class Migration20260714170000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "order_delivery"
        drop constraint if exists "order_delivery_provider_check";
    `);
    this.addSql(`
      alter table "order_delivery"
        add constraint "order_delivery_provider_check"
        check ("provider" in ('shippo','ups','uber','manual'));
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "order_delivery"
        drop constraint if exists "order_delivery_provider_check";
    `);
    this.addSql(`
      alter table "order_delivery"
        add constraint "order_delivery_provider_check"
        check ("provider" in ('shippo','ups','uber'));
    `);
  }
}
