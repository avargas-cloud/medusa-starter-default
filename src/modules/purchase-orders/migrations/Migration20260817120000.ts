import { Migration } from "@mikro-orm/migrations";

/**
 * Migration20260817120000
 *
 * Adds `freight_allocation_basis` to `vendor_bill`: which weight vector
 * `computeLandedLines` uses to spread the freight pool across product lines.
 * NULL = legacy policy (freight is an ExpenseLine of pure expense, NOT
 * capitalized into item cost). A non-null value ('units' | 'value' | 'cbm')
 * capitalizes freight into item cost using that basis, frozen at confirm.
 */
export class Migration20260817120000 extends Migration {
  async up(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill"
        ADD COLUMN IF NOT EXISTS "freight_allocation_basis" TEXT;
    `);
  }

  async down(): Promise<void> {
    await this.execute(`
      ALTER TABLE "vendor_bill"
        DROP COLUMN IF EXISTS "freight_allocation_basis";
    `);
  }
}
