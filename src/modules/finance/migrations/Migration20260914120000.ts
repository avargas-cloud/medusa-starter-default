import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * surcharge_cents — customer-paid card surcharge (Dejavoo terminal /
 * BAMS online), mirrored from `customer_payment.metadata` at create time.
 * NEVER part of `amount` (the AR side stays surcharge-free); the bank
 * deposits amount+surcharge, so the GL and deposit candidates add it back
 * as its own line. CHECK guards malformed writes, mirroring `batch_day`'s
 * `DO $$ IF NOT EXISTS pg_constraint` pattern.
 */
export class Migration20260914120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE customer_payment ADD COLUMN IF NOT EXISTS surcharge_cents integer NOT NULL DEFAULT 0;`
    );
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'customer_payment_surcharge_nonneg'
        ) THEN
          ALTER TABLE customer_payment
            ADD CONSTRAINT customer_payment_surcharge_nonneg
            CHECK (surcharge_cents >= 0);
        END IF;
      END $$;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE customer_payment DROP CONSTRAINT IF EXISTS customer_payment_surcharge_nonneg;`
    );
    this.addSql(
      `ALTER TABLE customer_payment DROP COLUMN IF EXISTS surcharge_cents;`
    );
  }
}
