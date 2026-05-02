import { Migration } from "@mikro-orm/migrations";

export class Migration20260502104900 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "pos_invoice_item" ADD COLUMN IF NOT EXISTS "attached_image" text NULL;`
    );
  }

  async down(): Promise<void> {
    this.addSql(
      `ALTER TABLE "pos_invoice_item" DROP COLUMN IF EXISTS "attached_image";`
    );
  }
}
