import { Migration } from "@mikro-orm/migrations";

/**
 * Adds sequential VB-XXXX numbering to vendor_bill.
 *   - custom_vendor_bill_seq  → shared Postgres sequence, VB-{seq}
 *   - number TEXT NULL        → human-readable bill number
 */
export class Migration20260428240000 extends Migration {
  async up(): Promise<void> {
    await this.execute(
      `CREATE SEQUENCE IF NOT EXISTS "custom_vendor_bill_seq" START 1001;`
    );
    await this.execute(
      `ALTER TABLE "vendor_bill" ADD COLUMN IF NOT EXISTS "number" TEXT NULL;`
    );
  }

  async down(): Promise<void> {
    await this.execute(
      `ALTER TABLE "vendor_bill" DROP COLUMN IF EXISTS "number";`
    );
    await this.execute(
      `DROP SEQUENCE IF EXISTS "custom_vendor_bill_seq";`
    );
  }
}
