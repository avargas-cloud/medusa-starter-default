import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Adds shipper column to inventory_transfer.
 * Values: ups | fedex | dhl | other
 */
export class Migration20260429120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "inventory_transfer" ADD COLUMN IF NOT EXISTS "shipper" TEXT NULL;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "inventory_transfer" DROP COLUMN IF EXISTS "shipper";`
    );
  }
}
