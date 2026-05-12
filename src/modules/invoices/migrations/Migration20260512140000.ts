import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add per-item discount snapshot to pos_invoice_item.
 *
 * Stores the line-level discount at invoice creation time so the invoice
 * display never needs to look up the live order for discount info.
 * NULL means no discount on that line.
 */
export class Migration20260512140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      ADD COLUMN IF NOT EXISTS discount_type  VARCHAR(10)      NULL,
      ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10, 4)   NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      DROP COLUMN IF EXISTS discount_type,
      DROP COLUMN IF EXISTS discount_value;
    `);
  }
}
