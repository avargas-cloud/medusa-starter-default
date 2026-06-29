import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Generic request-level idempotency for POST create routes (Phase 3 of the
 * idempotency initiative — see docs/IDEMPOTENCY_PLAN.md).
 *
 * A middleware claims a row here BEFORE the handler runs, so a double-click /
 * retry / replay carrying the same `Idempotency-Key` never executes the create
 * handler twice. The handler's response is cached and replayed on a completed
 * replay; an in-flight duplicate gets 409 + Retry-After; a same-key/different-
 * payload request gets 409 conflict.
 *
 * State machine (`status`):
 *   in_flight  — claimed, handler running. Concurrent dup → 409 IN_PROGRESS.
 *   completed  — handler finished; response_status/response_body replayed.
 *   failed     — handler errored deterministically; error replayed.
 *
 * `route` + `request_hash` detect same-key/different-request conflicts.
 * `expires_at` lets a cleanup job recycle stale in_flight claims (crash safety).
 */
export class CreateIdempotencyKey1779600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS idempotency_key (
        key             text PRIMARY KEY,
        route           text NOT NULL,
        request_hash    text NOT NULL,
        status          text NOT NULL DEFAULT 'in_flight',
        response_status int NULL,
        response_body   jsonb NULL,
        error_body      jsonb NULL,
        locked_at       timestamptz NOT NULL DEFAULT now(),
        completed_at    timestamptz NULL,
        expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
        created_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_idempotency_key_expires_at
        ON idempotency_key (expires_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_key;`);
  }
}
