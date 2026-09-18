import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * qb-pipeline-status-vocab-20260917 — SEAL.
 *
 * Third and last deploy. CONTRACT kept `pending` acceptable on
 * `qb_order_pipeline` because the EXPAND build was still writing it during
 * that deploy's cutover; the contract build read it as an alias of `waiting`
 * and dispatched it. Now no writer of `pending` exists, so:
 *
 *   - any straggler `pending` becomes `waiting` (expected 0; row triggers are
 *     bypassed so `updated_at` does not move);
 *   - the sales CHECK drops `pending` — canonical nine + display-only `manual`.
 *
 * `down` re-admits `pending`.
 */
export class QbPipelineStatusVocabSeal20260918000003 implements MigrationInterface {
  name = "QbPipelineStatusVocabSeal20260918000003";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`SET LOCAL session_replication_role = replica`);
    await q.query(`UPDATE "qb_order_pipeline" SET "status" = 'waiting' WHERE "status" = 'pending'`);
    await q.query(`SET LOCAL session_replication_role = origin`);
    await q.query(`ALTER TABLE "qb_order_pipeline" DROP CONSTRAINT IF EXISTS "qb_order_pipeline_status_check"`);
    await q.query(`
      ALTER TABLE "qb_order_pipeline"
        ADD CONSTRAINT "qb_order_pipeline_status_check"
        CHECK ("status" IN ('waiting','blocked','processing','submitted','synced','error','failed','skipped','fixed','manual')) NOT VALID
    `);
    await q.query(`ALTER TABLE "qb_order_pipeline" VALIDATE CONSTRAINT "qb_order_pipeline_status_check"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`ALTER TABLE "qb_order_pipeline" DROP CONSTRAINT IF EXISTS "qb_order_pipeline_status_check"`);
    await q.query(`
      ALTER TABLE "qb_order_pipeline"
        ADD CONSTRAINT "qb_order_pipeline_status_check"
        CHECK ("status" IN ('waiting','blocked','processing','submitted','synced','error','failed','skipped','fixed','pending','manual'))
    `);
  }
}
