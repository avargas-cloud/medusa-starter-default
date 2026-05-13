import { Migration } from "@mikro-orm/migrations";

export class Migration20260513120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order_receipt_line"
        ADD COLUMN IF NOT EXISTS "qty_on_hand_at_receive" integer NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order_receipt_line"
        DROP COLUMN IF EXISTS "qty_on_hand_at_receive";
    `);
  }
}
