import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Per-tab sequential counter for qb_order_pipeline.
 *
 * WHY: qb_order_pipeline is a SHARED table — Sales, payments, invoices,
 * credit memos, customer sync AND inventory adjustments all live in it. The
 * existing `seq` BIGSERIAL is therefore a GLOBAL counter. Tabs that show only
 * a slice of the table (Customer Sync = step IN customer/customer_data_ext,
 * Inventory Adjustments = step IN inventory_adjustment/void_inventory_adjustment)
 * inherit huge, non-consecutive seq values (e.g. 1801, 1692, 1680…) because
 * thousands of unrelated rows sit between them.
 *
 * This adds a `tab_seq` column populated at INSERT time by a per-category
 * Postgres sequence, so each of those tabs reads a dense 1, 2, 3… counter —
 * exactly like the tabs backed by their own table (Item, Vendor, PO).
 *
 *   - Customer Sync   → qb_customer_sync_tab_seq  (step customer + customer_data_ext,
 *                        both render as their own rows in the tab)
 *   - Inventory Adj.  → qb_inv_adjustment_tab_seq (step inventory_adjustment ONLY;
 *                        void_inventory_adjustment is merged into the adjustment
 *                        row via JOIN, so it must NOT consume a number or the
 *                        visible rows would have gaps again)
 *   - everything else (Sales) → tab_seq stays NULL; Sales keeps using `seq`.
 *
 * A BEFORE INSERT trigger assigns the value regardless of which code path
 * inserts the row (raw SQL, service, workflow), so it can never be missed.
 * Idempotent: column / sequences / trigger all guarded by IF NOT EXISTS /
 * CREATE OR REPLACE.
 */
export class AddTabSeqToQbOrderPipeline1778300000000
  implements MigrationInterface
{
  name = "AddTabSeqToQbOrderPipeline1778300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Column ─────────────────────────────────────────────────────────
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline ADD COLUMN IF NOT EXISTS tab_seq bigint`
    );

    // ── 2. Per-category sequences ─────────────────────────────────────────
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS qb_customer_sync_tab_seq`
    );
    await queryRunner.query(
      `CREATE SEQUENCE IF NOT EXISTS qb_inv_adjustment_tab_seq`
    );

    // ── 3. Backfill existing rows, per category, ordered by creation ──────
    await queryRunner.query(`
      WITH ordered AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY created_at ASC, seq ASC) AS rn
          FROM qb_order_pipeline
         WHERE step IN ('customer', 'customer_data_ext')
      )
      UPDATE qb_order_pipeline p
         SET tab_seq = ordered.rn
        FROM ordered
       WHERE p.id = ordered.id
    `);
    await queryRunner.query(`
      WITH ordered AS (
        SELECT id,
               ROW_NUMBER() OVER (ORDER BY created_at ASC, seq ASC) AS rn
          FROM qb_order_pipeline
         WHERE step = 'inventory_adjustment'
      )
      UPDATE qb_order_pipeline p
         SET tab_seq = ordered.rn
        FROM ordered
       WHERE p.id = ordered.id
    `);

    // ── 4. Advance each sequence past the backfilled max ─────────────────
    await queryRunner.query(`
      SELECT setval(
        'qb_customer_sync_tab_seq',
        COALESCE((SELECT MAX(tab_seq) FROM qb_order_pipeline
                   WHERE step IN ('customer', 'customer_data_ext')), 0) + 1,
        false
      )
    `);
    await queryRunner.query(`
      SELECT setval(
        'qb_inv_adjustment_tab_seq',
        COALESCE((SELECT MAX(tab_seq) FROM qb_order_pipeline
                   WHERE step = 'inventory_adjustment'), 0) + 1,
        false
      )
    `);

    // ── 5. Trigger: assign tab_seq on every INSERT ───────────────────────
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
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_qb_order_pipeline_tab_seq ON qb_order_pipeline`
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_qb_order_pipeline_tab_seq
        BEFORE INSERT ON qb_order_pipeline
        FOR EACH ROW
        EXECUTE FUNCTION qb_order_pipeline_assign_tab_seq()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_qb_order_pipeline_tab_seq ON qb_order_pipeline`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS qb_order_pipeline_assign_tab_seq()`
    );
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline DROP COLUMN IF EXISTS tab_seq`
    );
    await queryRunner.query(`DROP SEQUENCE IF EXISTS qb_customer_sync_tab_seq`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS qb_inv_adjustment_tab_seq`);
  }
}
