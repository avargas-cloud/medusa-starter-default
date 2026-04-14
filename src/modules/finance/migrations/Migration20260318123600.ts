import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Add medusa_payment_synced boolean to customer_payment.
 * true  = payment is already registered in Medusa's native Payment Module
 *         (web orders set this to true immediately; POS set after successful registerMedusaPayment())
 * false = not yet synced to Medusa native (POS payments before sync runs)
 */
export class Migration20260318123600 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "customer_payment"
      ADD COLUMN IF NOT EXISTS "medusa_payment_synced" BOOLEAN NOT NULL DEFAULT false;
    `);
    // Backfill: all web-sourced payments are already synced (they came FROM Medusa)
    this.addSql(`
      UPDATE "customer_payment"
      SET "medusa_payment_synced" = true
      WHERE "source" = 'web';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "customer_payment"
      DROP COLUMN IF EXISTS "medusa_payment_synced";
    `);
  }
}
