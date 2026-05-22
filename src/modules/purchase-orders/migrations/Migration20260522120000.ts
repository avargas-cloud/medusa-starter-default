import { Migration } from "@mikro-orm/migrations";

export class Migration20260522120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order"
        ADD COLUMN IF NOT EXISTS "tracking" jsonb NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE "purchase_order"
        DROP COLUMN IF EXISTS "tracking";
    `);
  }
}
