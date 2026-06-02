import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Register the `taxable` column on pos_invoice_item in the Medusa module
 * migration system. The column itself was created by the raw TypeORM migration
 * `1778000000000-AddTaxableToSalesItems.ts` (with NOT NULL DEFAULT TRUE and a
 * BEFORE INSERT trigger that auto-resolves the value from product.taxable via
 * the variant→product JOIN). This migration is a no-op on existing databases
 * but registers the column so the MikroORM module schema is in sync with the
 * model definition in pos-invoice-item.ts.
 */
export class Migration20260602100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice_item
      ADD COLUMN IF NOT EXISTS taxable boolean NOT NULL DEFAULT true;
    `);
  }

  override async down(): Promise<void> {
    // Column intentionally kept on down — removing it would lose snapshot data.
    // To fully revert, run the raw migration 1778000000000-AddTaxableToSalesItems down().
  }
}
