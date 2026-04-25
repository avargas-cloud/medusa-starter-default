import { Migration } from "@mikro-orm/migrations";

/**
 * Adds linked_order_ids column to purchase_order.
 * Stores a JSON array of Medusa order IDs that this PO fulfills.
 */
export class Migration20260424150000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order" ADD COLUMN IF NOT EXISTS "linked_order_ids" text NULL;`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order" DROP COLUMN IF EXISTS "linked_order_ids";`
    );
  }
}
