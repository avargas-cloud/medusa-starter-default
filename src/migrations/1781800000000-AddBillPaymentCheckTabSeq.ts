import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Dense per-tab numbering for the new Bill Payments tab.
 *
 * `qb_order_pipeline.seq` is a GLOBAL counter over a shared table, so any tab
 * showing only a slice of it inherits huge, gap-riddled numbers. The Bill Payments
 * tab is the worst case: `vendor_bill_payment_check` is the highest-volume step in
 * the table (752 of 5,455 rows at the time of writing), scattered between
 * thousands of unrelated sales rows.
 *
 * This extends the mechanism installed by AddTabSeqToQbOrderPipeline1778300000000
 * with a third category. The trigger function is REPLACED as a whole — including
 * the two pre-existing branches — because CREATE OR REPLACE FUNCTION has no
 * partial form; dropping a branch here would silently stop numbering that tab.
 *
 * Idempotent: sequence guarded by IF NOT EXISTS, function by CREATE OR REPLACE,
 * and the backfill only touches rows whose tab_seq is still NULL, so re-running it
 * can never renumber rows the UI has already shown.
 */
export class AddBillPaymentCheckTabSeq1781800000000
  implements MigrationInterface
{
  name = "AddBillPaymentCheckTabSeq1781800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Sequence for the new category ──────────────────────────────────
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS qb_bill_payment_tab_seq`
    );

    // ── 2. Backfill existing rows in creation order ───────────────────────
    // ORDER BY (created_at, seq): created_at alone is NOT unique here — the
    // hourly monitor inserts its whole batch under a single NOW() — so without
    // `seq` the ROW_NUMBER() assignment would itself be non-deterministic.
    await queryRunner.query(`
      WITH ordered AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY created_at ASC, seq ASC) AS rn
          FROM qb_order_pipeline
         WHERE step = 'vendor_bill_payment_check'
           AND tab_seq IS NULL
      )
      UPDATE qb_order_pipeline p
         SET tab_seq = ordered.rn
        FROM ordered
       WHERE p.id = ordered.id
    `);

    // ── 3. Advance the sequence past the backfilled max ───────────────────
    await queryRunner.query(`
      SELECT setval(
        'qb_bill_payment_tab_seq',
        COALESCE((SELECT MAX(tab_seq) FROM qb_order_pipeline
                   WHERE step = 'vendor_bill_payment_check'), 0) + 1,
        false
      )
    `);

    // ── 4. Trigger function, replaced whole (all three categories) ────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION qb_order_pipeline_assign_tab_seq()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.tab_seq IS NULL THEN
          IF NEW.step IN ('customer', 'customer_data_ext') THEN
            NEW.tab_seq := nextval('qb_customer_sync_tab_seq');
          ELSIF NEW.step = 'inventory_adjustment' THEN
            NEW.tab_seq := nextval('qb_inv_adjustment_tab_seq');
          ELSIF NEW.step = 'vendor_bill_payment_check' THEN
            NEW.tab_seq := nextval('qb_bill_payment_tab_seq');
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the two-category function exactly as 1778300000000 left it.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION qb_order_pipeline_assign_tab_seq()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.tab_seq IS NULL THEN
          IF NEW.step IN ('customer', 'customer_data_ext') THEN
            NEW.tab_seq := nextval('qb_customer_sync_tab_seq');
          ELSIF NEW.step = 'inventory_adjustment' THEN
            NEW.tab_seq := nextval('qb_inv_adjustment_tab_seq');
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      UPDATE qb_order_pipeline
         SET tab_seq = NULL
       WHERE step = 'vendor_bill_payment_check'
    `);
    await queryRunner.query(
      `DROP SEQUENCE IF EXISTS qb_bill_payment_tab_seq`
    );
  }
}
