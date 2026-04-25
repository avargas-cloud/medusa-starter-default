import { Migration } from "@mikro-orm/migrations";

/**
 * Adds shipping_method and payment_terms to purchase_order.
 * shipping_method: the carrier/method used to ship the order to Ecopowertech.
 * payment_terms:   free-text field for vendor payment terms (e.g. "Net 30").
 */
export class Migration20260425160000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order"
         ADD COLUMN IF NOT EXISTS "shipping_method" text NULL,
         ADD COLUMN IF NOT EXISTS "payment_terms"   text NULL;`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order"
         DROP COLUMN IF EXISTS "shipping_method",
         DROP COLUMN IF EXISTS "payment_terms";`
    );
  }
}
