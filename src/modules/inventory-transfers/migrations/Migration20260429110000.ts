import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds tracking_number column to inventory_transfer.
 */
export class Migration20260429110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "inventory_transfer" ADD COLUMN IF NOT EXISTS "tracking_number" TEXT NULL;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "inventory_transfer" DROP COLUMN IF EXISTS "tracking_number";`
    );
  }
}
