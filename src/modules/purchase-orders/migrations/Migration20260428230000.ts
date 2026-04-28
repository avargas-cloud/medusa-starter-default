import { Migration } from "@mikro-orm/migrations";

export class Migration20260428230000 extends Migration {
  async up(): Promise<void> {
    await this.execute(
      `ALTER TABLE "vendor_bill" ADD COLUMN IF NOT EXISTS "reference_id" TEXT NULL`
    );
    await this.execute(
      `ALTER TABLE "vendor_bill_line" ADD COLUMN IF NOT EXISTS "mpn" TEXT NULL`
    );
  }

  async down(): Promise<void> {
    await this.execute(
      `ALTER TABLE "vendor_bill" DROP COLUMN IF EXISTS "reference_id"`
    );
    await this.execute(
      `ALTER TABLE "vendor_bill_line" DROP COLUMN IF EXISTS "mpn"`
    );
  }
}
