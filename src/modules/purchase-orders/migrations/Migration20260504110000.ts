import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Allow fractional-cent purchase costs.
 *
 * Wire, aluminum and imported goods can have vendor costs below one cent or
 * costs that need 4 decimal places in dollars. Line/header totals remain cents.
 */
export class Migration20260504110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "purchase_order_line"
        alter column "unit_cost_cents" type double precision
        using "unit_cost_cents"::double precision;
    `);
    this.addSql(`
      alter table "purchase_order_receipt_line"
        alter column "unit_cost_cents_override" type double precision
        using "unit_cost_cents_override"::double precision;
    `);
    this.addSql(`
      alter table "vendor_bill_line"
        alter column "unit_cost_cents" type double precision
        using "unit_cost_cents"::double precision,
        alter column "landed_unit_cost_cents" type double precision
        using "landed_unit_cost_cents"::double precision;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table "vendor_bill_line"
        alter column "unit_cost_cents" type integer
        using round("unit_cost_cents")::integer,
        alter column "landed_unit_cost_cents" type integer
        using round("landed_unit_cost_cents")::integer;
    `);
    this.addSql(`
      alter table "purchase_order_receipt_line"
        alter column "unit_cost_cents_override" type integer
        using round("unit_cost_cents_override")::integer;
    `);
    this.addSql(`
      alter table "purchase_order_line"
        alter column "unit_cost_cents" type integer
        using round("unit_cost_cents")::integer;
    `);
  }
}
