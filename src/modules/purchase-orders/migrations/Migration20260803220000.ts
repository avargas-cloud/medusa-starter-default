import { Migration } from "@mikro-orm/migrations";

/**
 * Keep staff-entered ETAs separate from carrier API results.
 *
 * Freight carriers selected as `Other` have no adapter to populate
 * `carrier_eta`, but their public tracking pages still provide a useful date.
 * Storing that date in the automatic column would make a later provider or
 * tracking-number correction indistinguishable from a carrier response.
 */
export class Migration20260803220000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      alter table "purchase_order_tracking_number"
        add column if not exists "manual_eta" text null;
    `);
    this.addSql(`
      alter table "purchase_order_tracking_number"
        add constraint "purchase_order_tracking_number_manual_eta_check"
        check ("manual_eta" is null or "manual_eta" ~ '^\\d{4}-\\d{2}-\\d{2}$');
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      alter table "purchase_order_tracking_number"
        drop constraint if exists "purchase_order_tracking_number_manual_eta_check";
    `);
    this.addSql(`
      alter table "purchase_order_tracking_number"
        drop column if exists "manual_eta";
    `);
  }
}
