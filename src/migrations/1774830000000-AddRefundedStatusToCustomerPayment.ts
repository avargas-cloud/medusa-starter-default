import { Migration } from "@mikro-orm/migrations";

export class Migration1774830000000 extends Migration {
  async up(): Promise<void> {
    // Drop old constraint and recreate with refunded + partial_refunded
    this.addSql(`
            ALTER TABLE customer_payment
            DROP CONSTRAINT IF EXISTS customer_payment_status_check;
        `);
    this.addSql(`
            ALTER TABLE customer_payment
            ADD CONSTRAINT customer_payment_status_check
            CHECK (status = ANY (ARRAY[
                'available'::text,
                'partially_applied'::text,
                'applied'::text,
                'voided'::text,
                'refunded'::text,
                'partial_refunded'::text
            ]));
        `);
  }

  async down(): Promise<void> {
    this.addSql(`
            ALTER TABLE customer_payment
            DROP CONSTRAINT IF EXISTS customer_payment_status_check;
        `);
    this.addSql(`
            ALTER TABLE customer_payment
            ADD CONSTRAINT customer_payment_status_check
            CHECK (status = ANY (ARRAY[
                'available'::text,
                'partially_applied'::text,
                'applied'::text,
                'voided'::text
            ]));
        `);
  }
}
