import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260518130000
 *
 * Add a `metadata` jsonb column to `payment_application`.
 *
 * Motivation: the StandaloneCreditModal in store-pos used to create a
 * $0 anchor `customer_payment` row purely to carry checkout-event audit
 * metadata (transaction_id, capture_context, credits_consumed, etc.).
 * With this column, that audit trail lives on the actual application
 * row, and the apply route can stop synthesizing ghost $0 payments.
 *
 * Additive, nullable, safe to backfill later.
 */
export class Migration20260518130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE payment_application
      ADD COLUMN IF NOT EXISTS metadata jsonb NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE payment_application
      DROP COLUMN IF EXISTS metadata;
    `);
  }
}
