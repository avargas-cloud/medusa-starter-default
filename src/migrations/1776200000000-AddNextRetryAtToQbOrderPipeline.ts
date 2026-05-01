import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Section 1.5.15 — Add backoff infrastructure to qb_order_pipeline.
 *
 * Why: qb_item_pipeline and qb_purchase_order_pipeline have `next_retry_at`
 * for backoff scheduling, but qb_order_pipeline (covering customer / order
 * / payment / credit memo steps) does not. The first 3170 lock contention
 * on a customer DataExt op (incident 2026-05-01) had nowhere to be queued
 * for retry, so it went straight to `failed` and required manual intervention.
 *
 * This migration is purely additive:
 *   - new nullable column (existing rows untouched)
 *   - new partial index (only indexes rows actually subject to retry)
 *   - status enum is unchanged (column is `text`, no DB-level constraint)
 *
 * Callers that don't yet use `next_retry_at` keep working unchanged.
 */
export class AddNextRetryAtToQbOrderPipeline1776200000000
  implements MigrationInterface
{
  name = "AddNextRetryAtToQbOrderPipeline1776200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline
         ADD COLUMN IF NOT EXISTS next_retry_at timestamptz`
    );

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_pipeline_retry
         ON qb_order_pipeline (status, next_retry_at)
       WHERE status IN ('error', 'waiting')`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_retry`);
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline DROP COLUMN IF EXISTS next_retry_at`
    );
  }
}
