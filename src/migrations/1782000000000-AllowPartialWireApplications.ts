import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A bill paid short could never be finished paying.
 *
 * `idx_cwta_bill_once` made `china_wire_transfer_application.bill_id` unique, so
 * a bill was applied to exactly ONE wire for its entire life. That is right for
 * the ordinary case and wrong for the one that keeps happening: a vendor bill is
 * built missing a line, the wire pays the short amount and confirms, and weeks
 * later the difference surfaces. Correcting the bill raises its amount — the
 * recompute already derives the new balance — but the remainder had nowhere to
 * go: a second application collided with this index, and the split mechanism
 * refuses a bill whose wire is already confirmed.
 *
 * Measured on production when this was written: VB-1053 mirrors invoice
 * V260706-I1 for $3,775.15, its confirmed wire applied $3,763.37, and the
 * $11.78 remainder could not be scheduled by any path in the UI.
 *
 * WHY NOT SPLIT THE BILL INTO PARTIALS INSTEAD
 * --------------------------------------------
 * `china_finance_bill` already supports split groups, and that looks like the
 * native answer. It is not, for a bill that mirrors a vendor bill:
 * `recomputeBillFinanceLinks` is not split-aware — it writes the vendor bill's
 * line sum onto the row that carries `vendor_bill_id`, which is the group ROOT.
 * Splitting $3,775.15 into a root of $3,763.37 plus a child of $11.78 survives
 * until the next Save of that bill, which restores the root to $3,775.15 and
 * leaves the group summing $3,786.93. One row holding the invoice's real amount,
 * with as many applications as it takes to pay it, has no such failure mode.
 *
 * WHAT STILL PROTECTS THE DATA
 * ----------------------------
 * `idx_cwta_wire_bill` (UNIQUE on wire_transfer_id, bill_id) stays: a bill can
 * still never appear twice on the SAME wire. What this index was additionally
 * doing — capping total applications at the bill's amount — was a side effect,
 * not a statement, and it did not even hold: an overpaid bill legitimately
 * carries a confirmed application LARGER than its (later corrected) amount, and
 * the excess becomes a `china_finance_wire_credit`. VB-1045 sits at $3,025.00
 * with $3,136.50 applied today. So the replacement rule cannot be
 * "Σ applied ≤ amount"; it is enforced in the write path instead:
 *
 *     a NEW application may not exceed max(amount − Σ confirmed applied, 0)
 *
 * Confirmed applications are never revalidated — the money left the bank.
 * Paid-short schedules the remainder; paid-long schedules nothing and settles
 * through the credit path that already exists.
 */
export class AllowPartialWireApplications1782000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Created by scripts/migrations/backfill-china-finance-split-bills.ts, not
    // by a migration, so it is absent on any database that never ran that
    // backfill — hence IF EXISTS rather than a bare DROP.
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_cwta_bill_once`
    );

    // Restated so a reader of the schema finds the rule that replaced it.
    await queryRunner.query(
      `COMMENT ON TABLE china_wire_transfer_application IS
       'One row per (wire, bill). A bill may hold several applications — a bill paid short is finished on a later wire. A new application may not exceed max(bill.amount_cents - sum of CONFIRMED applications, 0); confirmed rows are never revalidated. Overpayment is not represented here: it settles through china_finance_wire_credit.'`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `COMMENT ON TABLE china_wire_transfer_application IS NULL`
    );
    // Deliberately not IF NOT EXISTS-with-a-swallow: if any bill has since been
    // paid across two wires, recreating a unique index on bill_id MUST fail
    // loudly. Rolling this back is only safe while no partial payment exists,
    // and silently dropping one to satisfy an index would destroy a payment
    // record.
    await queryRunner.query(
      `CREATE UNIQUE INDEX idx_cwta_bill_once
         ON china_wire_transfer_application (bill_id)`
    );
  }
}
