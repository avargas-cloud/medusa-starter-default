import { Migration } from "@mikro-orm/migrations";

/**
 * Vendor bill sales tax (2026-07-28).
 *
 * Some US vendors bill us sales tax instead of honouring a resale certificate
 * (e.g. Parts Express on PO-1029: $184.26 goods + $12.90 tax = $197.16). The
 * vendor bill had no slot for it at all, so the QuickBooks Bill we pushed was
 * short by the tax and never cleared against the real payment, and the tax was
 * missing from the landed cost that feeds average_cost.
 *
 * `tax_amount_cents` is a single header amount copied off the vendor document
 * (no `_included` flag and no sibling bill — unlike commission/freight/tariff,
 * the tax is a line of the SAME invoice). `tax_per_unit_cents` records the
 * capitalized share per line so the landed identity
 *   landed = unit + commission + freight + tariff + tax
 * stays reconstructible by the replay and drift engines.
 *
 * Backfill is a no-op by construction: every pre-existing bill carries zero
 * tax, which is exactly the column default.
 */
export class Migration20260728120000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS tax_amount_cents integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tax_account_list_id text NULL;
    `);
    this.addSql(`
      ALTER TABLE vendor_bill_line
        ADD COLUMN IF NOT EXISTS tax_per_unit_cents integer NOT NULL DEFAULT 0;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill_line
        DROP COLUMN IF EXISTS tax_per_unit_cents;
    `);
    this.addSql(`
      ALTER TABLE vendor_bill
        DROP COLUMN IF EXISTS tax_account_list_id,
        DROP COLUMN IF EXISTS tax_amount_cents;
    `);
  }
}
