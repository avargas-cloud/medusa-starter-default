import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260420220000
 *
 * Adds two columns to `unmet_demand_item`:
 *   - `thumbnail`          TEXT NULL — product image URL frozen at write time
 *   - `sales_description`  TEXT NULL — variant's customer-facing description
 *
 * Both survive the save → reload cycle so the cashier sees the same card
 * (image + marketing copy) after coming back to the record.
 */
export class Migration20260420220000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "unmet_demand_item" add column if not exists "thumbnail" text null;`
    );
    this.addSql(
      `alter table "unmet_demand_item" add column if not exists "sales_description" text null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "unmet_demand_item" drop column if exists "sales_description";`
    );
    this.addSql(
      `alter table "unmet_demand_item" drop column if exists "thumbnail";`
    );
  }
}
