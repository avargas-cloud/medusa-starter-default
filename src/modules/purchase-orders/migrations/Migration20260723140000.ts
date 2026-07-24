import { Migration } from "@mikro-orm/migrations";

/**
 * Adopted legacy bills (qb_source='adopted') are header-only mirrors of the
 * accountant's hand-entered QB bills — they carry NO lines, so every derived
 * total renders $0.00 in the POS list. This column stores the QB bill's
 * AmountDue (cents) captured by the reconciliation sweep, purely for display.
 * Never used in any accounting computation (drift/landed/AVCO all skip
 * adopted bills).
 */
export class Migration20260723140000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS qb_amount_due_cents integer NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill DROP COLUMN IF EXISTS qb_amount_due_cents;
    `);
  }
}
