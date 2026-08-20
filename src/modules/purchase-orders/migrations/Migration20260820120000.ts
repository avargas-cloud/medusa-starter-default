import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260820120000
 *
 * Widens `vendor_bill_bill_type_check` to admit the new `expense` bill type:
 * a standalone bill with no PO for operating expenses (supplies, installs,
 * office costs). Without this, INSERTs with bill_type='expense' fail at the
 * constraint even though every route accepts the value.
 */
export class Migration20260820120000 extends Migration {
  async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill"
        DROP CONSTRAINT IF EXISTS "vendor_bill_bill_type_check";
    `);
    await this.execute(`
      ALTER TABLE "vendor_bill"
        ADD CONSTRAINT "vendor_bill_bill_type_check"
        CHECK (bill_type = ANY (ARRAY['regular'::text, 'service'::text, 'freight'::text, 'tariff'::text, 'expense'::text]));
    `);
  }

  async down(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill"
        DROP CONSTRAINT IF EXISTS "vendor_bill_bill_type_check";
    `);
    await this.execute(`
      ALTER TABLE "vendor_bill"
        ADD CONSTRAINT "vendor_bill_bill_type_check"
        CHECK (bill_type = ANY (ARRAY['regular'::text, 'service'::text, 'freight'::text, 'tariff'::text]));
    `);
  }
}
