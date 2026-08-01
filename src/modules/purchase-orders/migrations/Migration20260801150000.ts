import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260801150000
 *
 * Vendor bills remember WHICH payment term they were written under, not just
 * how many days it was worth.
 *
 * `payment_terms_days` alone cannot round-trip a selection: two terms can share
 * a day count ("Due on Receipt" and "Prepaid" are both 0; "Net 30" and "Net-30"
 * are both 30 and are two DISTINCT terms in the company file). Storing only the
 * number means a bill reopened later cannot say which term produced it, so the
 * dropdown would have to guess — and would guess wrong on every 0-day bill.
 *
 * Additive and nullable on purpose: every existing bill keeps working with its
 * day count alone, and the column fills in as bills are saved. Nothing reads it
 * as required.
 */
export class Migration20260801150000 extends Migration {
  async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill"
        ADD COLUMN IF NOT EXISTS "payment_terms_name" TEXT;
    `);
  }

  async down(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill"
        DROP COLUMN IF EXISTS "payment_terms_name";
    `);
  }
}
