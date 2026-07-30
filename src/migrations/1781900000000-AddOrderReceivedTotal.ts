import { MigrationInterface, QueryRunner } from "typeorm";

import { RECOMPUTE_ORDER_MONEY_SQL } from "../lib/order-money/recompute-sql";

/**
 * The document needed a number neither half could answer.
 *
 * `deposit_cents` is money still sitting on the order (the list's "In Deposit")
 * and `applied_cents` is what invoices already consumed ("Paid Amt"). They never
 * overlap, and both are right for the LIST, which shows them side by side.
 *
 * A customer-facing DOCUMENT asks a third question: how much has this order
 * received. Feeding it the unused half made S11179 — deposited in full,
 * $16,776.23 unused of an $18,917.94 order after $2,141.71 was billed — print a
 * Deposit of $16,776.23 and a Balance of $2,141.71: the balance was exactly the
 * money already collected.
 *
 * WHY DERIVED IN THE FUNCTION AND NOT ADDED IN THE FRONTEND
 * --------------------------------------------------------
 * The first fix summed the two mirrors in the POS. It worked and it was wrong:
 * the same formula would then live in the on-screen summary, the print path and
 * the email modal, and one of its two inputs came from a LIVE query against
 * /admin/finance/customers/:id/balance while the other came from this mirror —
 * two sources for one sentence about money. Deriving it once, here, is the same
 * argument that created this projection in the first place: maintenance by
 * callsite is the bug, not the cure.
 *
 * `received_cents` is GENERATED, not computed by the function, so it cannot
 * drift from the two columns it sums even if a future edit forgets it. It
 * inherits the ceiling for free: `deposit_cents` is already clamped to
 * `total - applied`, so received never exceeds the order and a genuine
 * overpayment stays unlinked customer credit — the operator's rule, untouched.
 *
 * Measured before writing this: 0 of 1,298 live payment_applications have an
 * invoice_id without an order_id, so `applied_cents` really is "payments linked
 * to THIS order that landed on its invoices" and the sum really is everything
 * the order received. If that ever stops being true, this number is the first
 * thing that lies.
 *
 * NOT self-applying, same as 1781700000000: replacing the function fixes every
 * FUTURE recompute, but every existing order is missing `deposit_total` until
 * something recomputes it, and the triggers will not revisit an order nobody
 * touches. Run `SELECT recompute_all_order_money();` after this deploys. The
 * POS falls back to `referential_deposit + applied_total` until then, so the
 * window is degraded-but-correct rather than blank.
 */
export class AddOrderReceivedTotal1781900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Generated, so the table states the relationship instead of asking every
    // audit script to re-derive it. Not listed in the function's INSERT — a
    // generated column cannot be written, and must not be.
    await queryRunner.query(`
      ALTER TABLE order_money_projection
      ADD COLUMN IF NOT EXISTS received_cents bigint
        GENERATED ALWAYS AS (applied_cents + deposit_cents) STORED
    `);

    await queryRunner.query(RECOMPUTE_ORDER_MONEY_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The column goes; the function body does not roll back. Reinstalling the
    // previous body would mean keeping a hand-copied duplicate of it here,
    // which is the failure mode lib/order-money/recompute-sql.ts exists to
    // prevent. A stale `deposit_total` key in metadata is inert — no reader
    // that predates this migration looks for it.
    await queryRunner.query(`
      ALTER TABLE order_money_projection DROP COLUMN IF EXISTS received_cents
    `);
  }
}
