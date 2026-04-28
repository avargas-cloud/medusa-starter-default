import { Migration } from "@mikro-orm/migrations";

export class Migration20260427200000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order_receipt"
        DROP CONSTRAINT IF EXISTS "purchase_order_receipt_status_check";
    `);
    this.addSql(`
      ALTER TABLE "purchase_order_receipt"
        ADD CONSTRAINT "purchase_order_receipt_status_check"
        CHECK (status = ANY (ARRAY[
          'pending'::text,
          'applied'::text,
          'synced'::text,
          'voided'::text,
          'deleted'::text,
          'error'::text
        ]));
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order_receipt"
        DROP CONSTRAINT IF EXISTS "purchase_order_receipt_status_check";
    `);
    this.addSql(`
      ALTER TABLE "purchase_order_receipt"
        ADD CONSTRAINT "purchase_order_receipt_status_check"
        CHECK (status = ANY (ARRAY[
          'pending'::text,
          'applied'::text,
          'synced'::text,
          'voided'::text,
          'error'::text
        ]));
    `);
  }
}
