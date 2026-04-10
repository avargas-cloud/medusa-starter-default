import { MigrationInterface, QueryRunner } from "typeorm"

export class AddQbPipelineStaleIndexes1774910000000 implements MigrationInterface {
    name = "AddQbPipelineStaleIndexes1774910000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Supports findLatestInFlightRow() — fetches the most recent pending/submitted
        // row for a given order + step without scanning confirmed/failed rows
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_pipeline_inflight
            ON qb_order_pipeline (order_id, step, created_at DESC)
            WHERE status IN ('pending', 'submitted')
        `)

        // Supports stale-row detection for submitted rows (bridge never responded)
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_pipeline_stale_submitted
            ON qb_order_pipeline (updated_at)
            WHERE status = 'submitted'
        `)

        // Supports stale-row detection for pending rows (never dispatched)
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_pipeline_stale_pending
            ON qb_order_pipeline (updated_at)
            WHERE status = 'pending'
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_inflight`)
        await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_stale_submitted`)
        await queryRunner.query(`DROP INDEX IF EXISTS idx_qb_pipeline_stale_pending`)
    }
}
