import { Migration } from "@mikro-orm/migrations";

export class Migration20260425220000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order"
        ADD COLUMN IF NOT EXISTS "qb_edit_sequence" text NULL;
    `);
    this.addSql(`
      ALTER TABLE "purchase_order_line"
        ADD COLUMN IF NOT EXISTS "qb_txn_line_id" text NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "purchase_order" DROP COLUMN IF EXISTS "qb_edit_sequence";`
    );
    this.addSql(
      `ALTER TABLE "purchase_order_line" DROP COLUMN IF EXISTS "qb_txn_line_id";`
    );
  }
}
