import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260821200000
 *
 * Adds `landed_total_cents` to `vendor_bill_line`: the EXACT landed money for
 * the line (goods + its share of commission/freight/tariff/tax), allocated by
 * `allocateLineTotalsCents` — no per-unit integer constraint, so it always
 * sums to the pool total.
 *
 * This is the single source of truth `computeLandedLines` already computed
 * and discarded after using it for AVCO — the confirm route now persists it,
 * and the QB enqueue (ADD/MOD) and the vendor-bills list/detail read it
 * instead of each recomputing their own copy of the same math. Nullable:
 * historical rows get it via a separate backfill, never inferred here.
 */
export class Migration20260821200000 extends Migration {
  async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill_line"
        ADD COLUMN IF NOT EXISTS "landed_total_cents" INTEGER;
    `);
  }

  async down(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill_line"
        DROP COLUMN IF EXISTS "landed_total_cents";
    `);
  }
}
