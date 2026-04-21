import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260421120000
 *
 * Adds a user-managed workflow status column `po_status` to purchase_order.
 * This is independent from the lifecycle `status` column (draft / submitted /
 * received / ...). Values are drawn from the `PO Status` field in the
 * system_defaults table (e.g. "PO Sent", "US Customs Delay", ...).
 *
 * Nullable: old rows — and drafts that haven't been tagged yet — carry null.
 */
export class Migration20260421120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "purchase_order" add column if not exists "po_status" text null;`
    );
    this.addSql(
      `create index if not exists "IDX_purchase_order_po_status" on "purchase_order" ("po_status") where "po_status" is not null and "deleted_at" is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_purchase_order_po_status";`);
    this.addSql(`alter table "purchase_order" drop column if exists "po_status";`);
  }
}
