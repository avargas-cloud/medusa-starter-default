import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Append-only defer log for unattributed (unlinked) Treasury payments.
 *
 * The accounts manager can push a still-unlinked payment's cash to the next
 * treasury day instead of linking it, so a day's "Confirm Transfers" isn't
 * blocked forever. This ONLY affects Treasury's own day-bucketing math — it
 * never touches `customer_payment.received_at`/`batch_day` (those still feed
 * the unrelated QuickBooks TxnDate mechanism).
 *
 * Append-only on purpose: a payment that's still unlinked the next day and
 * gets deferred again leaves a full audit trail (July 15→16, then 16→17)
 * instead of overwriting a single mutable row. "Current effective date" for
 * a payment = its most recent row (see load-unattributed-payments.ts).
 *
 * Also adds a UNIQUE constraint on treasury_distribution_log.distribution_date:
 * the old snapshot/mark_executed two-step flow (which allowed multiple
 * snapshots per day, only one of them ever executed) is being collapsed into
 * one atomic "confirm" action that always inserts an already-executed row —
 * so at most one row per day is possible going forward. Safe because the
 * table is empty in prod today (the old flow was never actually used).
 */
export class CreateTreasuryPaymentDefer1780000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS treasury_payment_defer (
        id                            TEXT PRIMARY KEY,
        payment_id                    TEXT NOT NULL REFERENCES customer_payment(id) ON DELETE CASCADE,
        deferred_from_date            DATE NOT NULL,
        effective_treasury_date       DATE NOT NULL,
        unapplied_cents_at_deferral   BIGINT NOT NULL,
        reason                        TEXT NULL,
        created_by_user_id            TEXT NULL,
        created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_tpd_payment_id_created_at
        ON treasury_payment_defer(payment_id, created_at DESC)
    `);

    await queryRunner.query(`
      ALTER TABLE treasury_distribution_log
        ADD CONSTRAINT uq_tdl_distribution_date UNIQUE (distribution_date)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE treasury_distribution_log
        DROP CONSTRAINT IF EXISTS uq_tdl_distribution_date
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_tpd_payment_id_created_at`);
    await queryRunner.query(`DROP TABLE IF EXISTS treasury_payment_defer`);
  }
}
