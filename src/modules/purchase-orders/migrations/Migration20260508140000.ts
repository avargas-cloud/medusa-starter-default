import { Migration } from "@mikro-orm/migrations";

export class Migration20260508140000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS document_date timestamptz NULL;
    `);

    this.addSql(`
      UPDATE vendor_bill
      SET document_date = created_at
      WHERE document_date IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        DROP COLUMN IF EXISTS document_date;
    `);
  }
}
