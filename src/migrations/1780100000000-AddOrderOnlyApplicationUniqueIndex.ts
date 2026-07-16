import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Partial unique index: at most ONE active order-only payment_application per
 * (payment_id, order_id).
 *
 * Final DB-level safety net for the terminal-payment orphan / Treasury
 * double-count class of bugs: an order-only row (invoice_id IS NULL) is a
 * convertible reservation, and every reader (CONVERT-ON-APPLY in
 * admin/invoices + finance/payments/[id]/apply, refund release, credit panel)
 * assumes it can treat the reservation for a (payment, order) pair as a
 * single unit. Duplicate rows double-count the same cash.
 *
 * Ships TOGETHER with the upsert refactor (lib/finance/
 * upsert-order-only-application.ts): a second legitimate link to the same
 * order now INCREMENTS the existing reservation instead of inserting a second
 * row — without that change this index would reject a valid business action.
 *
 * Prod was verified to have ZERO duplicate groups (2026-07-16); the merge
 * statements below are a defensive no-op unless a duplicate slipped in during
 * the deploy window: amounts roll up into the OLDEST row (min id), younger
 * rows are soft-deleted with an audit marker. raw_amount_applied (BigNumber
 * JSONB) is updated alongside the numeric column — Medusa reads from raw_*.
 */
export class AddOrderOnlyApplicationUniqueIndex1780100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) Roll duplicate-group amounts into the oldest row per (payment, order).
    await queryRunner.query(`
      WITH agg AS (
        SELECT payment_id, order_id,
               SUM(amount_applied)::numeric AS total,
               MIN(id) AS keep_id
          FROM payment_application
         WHERE invoice_id IS NULL AND voided_at IS NULL AND deleted_at IS NULL
         GROUP BY payment_id, order_id
        HAVING COUNT(*) > 1
      )
      UPDATE payment_application keep
         SET amount_applied = agg.total,
             raw_amount_applied = jsonb_build_object('value', agg.total::text, 'precision', 20),
             updated_at = NOW()
        FROM agg
       WHERE keep.id = agg.keep_id
    `);

    // 2) Soft-delete the younger duplicates (audit-preserving), pointing at
    //    the surviving row. Recomputing agg here is safe: keep_id (MIN(id))
    //    is unchanged by step 1, and this statement never touches keep_id.
    await queryRunner.query(`
      WITH agg AS (
        SELECT payment_id, order_id, MIN(id) AS keep_id
          FROM payment_application
         WHERE invoice_id IS NULL AND voided_at IS NULL AND deleted_at IS NULL
         GROUP BY payment_id, order_id
        HAVING COUNT(*) > 1
      )
      UPDATE payment_application pa
         SET deleted_at = NOW(),
             updated_at = NOW(),
             metadata = COALESCE(pa.metadata, '{}'::jsonb)
                        || jsonb_build_object('merged_into_application_id', agg.keep_id)
        FROM agg
       WHERE pa.payment_id = agg.payment_id
         AND pa.order_id = agg.order_id
         AND pa.invoice_id IS NULL AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
         AND pa.id <> agg.keep_id
    `);

    // 3) The lock itself.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payment_application_order_only_active"
        ON payment_application (payment_id, order_id)
        WHERE invoice_id IS NULL AND voided_at IS NULL AND deleted_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_payment_application_order_only_active"`
    );
    // The duplicate merge is not reversed — it is a data repair, not schema.
  }
}
