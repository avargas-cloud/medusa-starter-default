import { Migration } from "@mikro-orm/migrations";

/**
 * `vendor_bill.qb_missing_in_qb_at` — the linked QuickBooks Bill is gone.
 *
 * WHY: the hourly payment monitor re-elects any linked unpaid bill whose
 * `qb_payment_checked_at` is older than 12 h, and its NOT EXISTS guard only
 * suppresses rows in pending/processing/submitted/waiting. A bill whose QB
 * document was DELETED can therefore never settle: the check fails, the
 * checked-at stamp never advances, `failed` does not suppress anything, and the
 * next tick queues another row — one permanently-failed row per hour, forever.
 * Observed live on bill FTL - 1573151 (adopted mirror, ELA Florida, $1,807.00):
 * four failed rows in the four hours after the accountant deleted it in QB.
 *
 * A deleted document is a terminal fact, not a transient failure, so it gets a
 * durable marker instead of a retry. Cleared only by an explicit human re-check.
 */
export class Migration20260730040000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        ADD COLUMN IF NOT EXISTS qb_missing_in_qb_at timestamptz NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      ALTER TABLE vendor_bill
        DROP COLUMN IF EXISTS qb_missing_in_qb_at;
    `);
  }
}
