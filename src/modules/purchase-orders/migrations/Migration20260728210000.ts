import { Migration } from "@mikro-orm/migrations";

/**
 * Vendor bill soft delete (2026-07-28).
 *
 * Deleting a vendor bill used to remove the row outright, which threw away the
 * VB-#### it had been assigned: the sequence never reuses a number, so the
 * document simply vanished from the series with nothing to explain the gap.
 * A deleted bill now keeps its row and its number, carrying `status='deleted'`
 * alongside `deleted_at`.
 *
 * `deleted_at` is set as well, deliberately. Practically every query in the
 * codebase already ends in `deleted_at IS NULL`, so the existing invisibility
 * contract does the work — a deleted bill drops out of billed-status maths,
 * receipt binding, drift, and duplicate-reference checks without a status
 * filter having to be added to each one. Only the list route opts back in, to
 * show the gap for what it is.
 */
export class Migration20260728210000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        DROP CONSTRAINT IF EXISTS vendor_bill_status_check;
    `);
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD CONSTRAINT vendor_bill_status_check
        CHECK (status IN ('draft','confirmed','synced','cancelled','voided','deleted'));
    `);
  }

  async down(): Promise<void> {
    // Rows already marked deleted would violate the narrower constraint; drop
    // them back to 'cancelled', the closest terminal state that predates this.
    this.addSql(`
      UPDATE vendor_bill SET status = 'cancelled' WHERE status = 'deleted';
    `);
    this.addSql(`
      ALTER TABLE vendor_bill
        DROP CONSTRAINT IF EXISTS vendor_bill_status_check;
    `);
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD CONSTRAINT vendor_bill_status_check
        CHECK (status IN ('draft','confirmed','synced','cancelled','voided'));
    `);
  }
}
