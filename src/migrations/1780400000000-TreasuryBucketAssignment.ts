import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Treasury bucket-assignment redesign (2026-07-21).
 *
 * 1. `treasury_payment_credit_resolution` — the accountant's "treat this
 *    unlinked payment remainder as customer credit" decision from the
 *    "Payments not linked to an order" panel. One active row per payment
 *    (UPSERT on re-resolve). `amount_cents` snapshots the unapplied remainder
 *    at resolution time; if the live remainder later drifts (new application,
 *    partial refund) the resolution is treated as stale and re-blocks the day.
 *    `bucket` is where the accountant says that credit's cash sits/moves
 *    (unattributed cash factually lands in `operating` via compute-splits, so
 *    "keep" = operating and any other bucket is a manual transfer they execute
 *    at the bank). Advisory + audit — never feeds the split math.
 *
 * 2. `treasury_cm_movement_resolution` — widened from confirm/ignore/N-A to
 *    direct bucket assignment: 'kept' (leave the credit's cash where it is) or
 *    'moved' (manual transfer current→target of the credit's FACE VALUE — not
 *    the COGS-overlap cents; backing/consumption stay as audit context in
 *    movement_json). Legacy values remain valid for old snapshot display.
 */
export class TreasuryBucketAssignment1780400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS treasury_payment_credit_resolution (
        id                   TEXT PRIMARY KEY,
        payment_id           TEXT NOT NULL,
        bucket               TEXT NOT NULL
          CHECK (bucket IN ('china_cogs', 'local_cogs', 'operating', 'reserve')),
        amount_cents         BIGINT NOT NULL,
        reason               TEXT NULL,
        resolved_by_user_id  TEXT NULL,
        resolved_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT uq_tpcr_payment_id UNIQUE (payment_id)
      )
    `);

    await queryRunner.query(`
      ALTER TABLE treasury_cm_movement_resolution
        DROP CONSTRAINT IF EXISTS treasury_cm_movement_resolution_resolution_check
    `);
    await queryRunner.query(`
      ALTER TABLE treasury_cm_movement_resolution
        ADD CONSTRAINT treasury_cm_movement_resolution_resolution_check
        CHECK (resolution IN ('confirmed', 'ignored', 'unattributable', 'kept', 'moved'))
    `);
    await queryRunner.query(`
      ALTER TABLE treasury_cm_movement_resolution
        ADD COLUMN IF NOT EXISTS current_bucket TEXT NULL,
        ADD COLUMN IF NOT EXISTS target_bucket TEXT NULL,
        ADD COLUMN IF NOT EXISTS amount_cents BIGINT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS treasury_payment_credit_resolution`
    );
    await queryRunner.query(`
      ALTER TABLE treasury_cm_movement_resolution
        DROP COLUMN IF EXISTS current_bucket,
        DROP COLUMN IF EXISTS target_bucket,
        DROP COLUMN IF EXISTS amount_cents
    `);
    await queryRunner.query(`
      ALTER TABLE treasury_cm_movement_resolution
        DROP CONSTRAINT IF EXISTS treasury_cm_movement_resolution_resolution_check
    `);
    await queryRunner.query(`
      ALTER TABLE treasury_cm_movement_resolution
        ADD CONSTRAINT treasury_cm_movement_resolution_resolution_check
        CHECK (resolution IN ('confirmed', 'ignored', 'unattributable'))
    `);
  }
}
