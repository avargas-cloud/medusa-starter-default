import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Normalize the unified Sales QB pipeline to one visible failure status.
 *
 * qb_order_pipeline uses `failed` as the operator-facing state. Retryable
 * failures are represented by `failed + next_retry_at`; terminal failures use
 * `failed + next_retry_at IS NULL`.
 */
export class NormalizeQbOrderPipelineFailedStatus1778100000000
  implements MigrationInterface
{
  name = "NormalizeQbOrderPipelineFailedStatus1778100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE qb_order_pipeline
         SET status = 'failed',
             failed_at = COALESCE(failed_at, updated_at, NOW()),
             updated_at = NOW()
       WHERE status = 'error'
    `);

    await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_retry`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qb_pipeline_retry
        ON qb_order_pipeline (status, next_retry_at)
      WHERE status IN ('failed', 'waiting')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_retry`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_qb_pipeline_retry
        ON qb_order_pipeline (status, next_retry_at)
      WHERE status IN ('error', 'waiting')
    `);
  }
}
