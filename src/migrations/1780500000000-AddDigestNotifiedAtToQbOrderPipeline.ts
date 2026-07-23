import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * `digest_notified_at` for qb_order_pipeline — closes the "dead and invisible"
 * blind spot in the daily error digest.
 *
 * WHY: the digest's sales-pipeline query is windowed on `updated_at`:
 *
 *     WHERE status = 'failed' AND next_retry_at IS NULL
 *       AND updated_at >= now() - 24h
 *
 * That is fire-ONCE by design ("older still-broken rows already showed up in
 * earlier digests"). It assumes a human acts the day a row breaks. A row that
 * exhausts its retry ladder goes dormant — `failed`, `next_retry_at NULL`,
 * nothing ever touching it again — so its `updated_at` freezes, it drops out of
 * the 24h window the next day, and it is never reported again while remaining
 * broken. CM-1087 sat that way for 14 days after a single digest mention.
 *
 * qb_item_pipeline already solved this: a re-surface bucket deduped on
 * `digest_notified_at` (new / changed since last notice / 7 days of silence).
 * This column lets the sales pipeline use the same mechanism.
 *
 * Idempotent (IF NOT EXISTS) and additive — nullable, no backfill, so every
 * existing broken row reads as "never notified" and surfaces in the next
 * digest. That is the intended behaviour: on first run after deploy the digest
 * reports the full standing backlog once, then settles into the 7-day cadence.
 */
export class AddDigestNotifiedAtToQbOrderPipeline1780500000000
  implements MigrationInterface
{
  name = "AddDigestNotifiedAtToQbOrderPipeline1780500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline ADD COLUMN IF NOT EXISTS digest_notified_at timestamptz NULL`
    );
    // The re-surface bucket scans dormant failures: status + next_retry_at
    // narrow it, digest_notified_at orders the dedup. Partial index keeps it
    // tiny — healthy rows are never in it.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_order_pipeline_dormant_failed
         ON qb_order_pipeline (digest_notified_at, updated_at)
       WHERE status = 'failed' AND next_retry_at IS NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS idx_qb_order_pipeline_dormant_failed`
    );
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline DROP COLUMN IF EXISTS digest_notified_at`
    );
  }
}
