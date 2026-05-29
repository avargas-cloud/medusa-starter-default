import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * EVITAR DUPS (A2) — structural backstop for the apply_payment dual-keying bug.
 *
 * After A1 every apply_payment pipeline row keys reference_id by
 * payment_application.id (papp_). This partial UNIQUE index enforces, at the DB
 * level, at most ONE non-skipped apply_payment row per payment_application —
 * closing the TOCTOU race in requeueApplyPaymentWaiting / writePipelineRow that
 * the UPDATE-then-INSERT guard can't fully prevent.
 *
 * Scope decisions:
 *   - reference_type = 'payment_application' only → legacy customer_payment
 *     (cpay_) rows are excluded, where the same payment legitimately applies to
 *     multiple invoices under one cpay_ id (would otherwise collide). Verified:
 *     0 duplicate papp_ ids exist in prod, so creation succeeds without cleanup.
 *   - status <> 'skipped' (NOT active-only) → covers 'confirmed' too, so a
 *     confirmed apply can never be re-inserted as a new active row → no double
 *     ReceivePayment. Re-tries must revive the existing row, not insert another.
 *
 * Idempotent (IF NOT EXISTS) per the custom-migration runner contract.
 */
export class AddApplyPaymentPappUniqueIndex1779100000000
  implements MigrationInterface
{
  name = "AddApplyPaymentPappUniqueIndex1779100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_qb_pipeline_apply_payment_papp
      ON qb_order_pipeline (reference_id)
      WHERE step = 'apply_payment'
        AND reference_type = 'payment_application'
        AND status <> 'skipped'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS uq_qb_pipeline_apply_payment_papp`
    );
  }
}
