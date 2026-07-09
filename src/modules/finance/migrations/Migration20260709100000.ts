import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * batch_day — merchant batch day (ET, 'YYYY-MM-DD') per customer_payment.
 *
 * Payments taken after the merchant batch cutoff (default 18:45 ET) belong to
 * the NEXT day's batch. Text (not date) to match the model DML and the
 * YYYY-MM-DD strings used across the QB layer; zero-padded so lexical range
 * filters are chronological. CHECK guards malformed writes.
 */
export class Migration20260709100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE customer_payment ADD COLUMN IF NOT EXISTS batch_day text;`
    );
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'customer_payment_batch_day_format'
        ) THEN
          ALTER TABLE customer_payment
            ADD CONSTRAINT customer_payment_batch_day_format
            CHECK (batch_day IS NULL OR batch_day ~ '^\\d{4}-\\d{2}-\\d{2}$');
        END IF;
      END $$;
    `);
    this.addSql(
      `CREATE INDEX IF NOT EXISTS idx_customer_payment_batch_day ON customer_payment (batch_day);`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS idx_customer_payment_batch_day;`
    );
    this.addSql(
      `ALTER TABLE customer_payment DROP CONSTRAINT IF EXISTS customer_payment_batch_day_format;`
    );
    this.addSql(
      `ALTER TABLE customer_payment DROP COLUMN IF EXISTS batch_day;`
    );
  }
}
