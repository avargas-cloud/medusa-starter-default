import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUpdatedAtToQbPipeline1774900000000 implements MigrationInterface {
  name = "AddUpdatedAtToQbPipeline1774900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add updated_at column
    await queryRunner.query(`
            ALTER TABLE qb_order_pipeline
            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT NOW()
        `);

    // Backfill: use most recent lifecycle timestamp as the starting value
    await queryRunner.query(`
            UPDATE qb_order_pipeline
            SET updated_at = COALESCE(confirmed_at, failed_at, submitted_at, created_at)
        `);

    // Auto-update trigger function
    await queryRunner.query(`
            CREATE OR REPLACE FUNCTION fn_qb_pipeline_touch_updated_at()
            RETURNS trigger AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql
        `);

    await queryRunner.query(`
            DROP TRIGGER IF EXISTS trg_qb_pipeline_updated_at ON qb_order_pipeline
        `);
    await queryRunner.query(`
            CREATE TRIGGER trg_qb_pipeline_updated_at
            BEFORE UPDATE ON qb_order_pipeline
            FOR EACH ROW EXECUTE FUNCTION fn_qb_pipeline_touch_updated_at()
        `);

    // Index for new sort order
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_pipeline_updated
            ON qb_order_pipeline (status, updated_at DESC)
        `);

    // Dedup lookup indexes
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_pipeline_dedup_ref
            ON qb_order_pipeline (reference_id, step)
            WHERE reference_id IS NOT NULL
        `);
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_pipeline_dedup_order
            ON qb_order_pipeline (order_id, step)
            WHERE order_id IS NOT NULL AND reference_id IS NULL
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_qb_pipeline_updated_at ON qb_order_pipeline`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS fn_qb_pipeline_touch_updated_at()`
    );
    await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_updated`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_dedup_ref`);
    await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_dedup_order`);
    await queryRunner.query(
      `ALTER TABLE qb_order_pipeline DROP COLUMN IF EXISTS updated_at`
    );
  }
}
