import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Durable, PII-free evidence for native order completion attempts.
 *
 * Railway logs are intentionally ephemeral, while a completion attempt can
 * soft-bail (`busy`, a guard, or a workflow failure) without failing the HTTP
 * request. Keeping the evaluated facts for 30 days makes the next orphaned
 * order diagnosable without guessing from its final state.
 */
export class CreateOrderCompletionAttempt1782200000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_completion_attempt (
        id          bigserial   PRIMARY KEY,
        order_id    text        NOT NULL,
        source      text        NOT NULL,
        outcome     text        NOT NULL,
        reason      text,
        facts       jsonb       NOT NULL DEFAULT '{}'::jsonb,
        created_at  timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "CHK_order_completion_attempt_outcome"
          CHECK (outcome IN ('completed', 'skipped'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_completion_attempt_order_created"
        ON order_completion_attempt (order_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_order_completion_attempt_actionable"
        ON order_completion_attempt (created_at DESC)
        WHERE outcome = 'skipped'
          AND reason IN ('busy', 'workflow_error')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS order_completion_attempt`);
  }
}
