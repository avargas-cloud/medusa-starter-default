import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Creates qb_sync_log table to track all QuickBooks operations.
 * Covers 2 types of processes:
 *   1. Order lifecycle events (order.placed, payment_captured, fulfillment_created, etc.)
 *   2. Admin panel batch syncs (inventory, prices, customers — scheduled or manual)
 */
export class CreateQuickBooksLog1740780000000 implements MigrationInterface {
  name = "CreateQuickBooksLog1740780000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS qb_sync_log (
                id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                operation_id        VARCHAR(64),
                -- Order lifecycle fields
                order_id            VARCHAR(255),
                order_display_id    INTEGER,
                draft_order_id      VARCHAR(255),
                -- Batch sync fields
                sync_type           VARCHAR(32),        -- 'inventory' | 'price' | 'customer' | null for order events
                triggered_by        VARCHAR(16),        -- 'auto' | 'manual' | 'event'
                -- Common classification
                event_type          VARCHAR(64),        -- 'order.placed' | 'payment_captured' | 'price_sync' | etc.
                operation           VARCHAR(64),        -- 'sales_order' | 'payment' | 'invoice' | 'estimate' | 'inventory_sync' | 'price_sync' | 'customer_sync'
                status              VARCHAR(16) NOT NULL DEFAULT 'processing', -- 'processing' | 'completed' | 'failed' | 'skipped'
                -- QB result data
                qb_txn_id           VARCHAR(64),
                qb_ref_number       VARCHAR(64),
                qb_operation_id     VARCHAR(128),
                -- Human-readable info
                message             TEXT,
                error               TEXT,
                metadata            JSONB,
                -- Timing
                initiated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                completed_at        TIMESTAMPTZ,
                duration_ms         INTEGER
            )
        `);

    // Indexes for common query patterns
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_sync_log_order_id ON qb_sync_log(order_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_sync_log_display_id ON qb_sync_log(order_display_id)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_sync_log_status ON qb_sync_log(status)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_sync_log_operation ON qb_sync_log(operation)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_sync_log_initiated ON qb_sync_log(initiated_at DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_qb_sync_log_operation_id ON qb_sync_log(operation_id)`
    );

    // Auto-cleanup: delete rows older than 90 days via pg_cron (Railway supports this).
    // This keeps the table permanently tiny (~210 rows/day × 90 days = ~19k rows max = ~10MB tops).
    // If pg_cron is not available, the cleanup is done manually via the quickbooks-daily-sync job.
    await queryRunner.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
                    PERFORM cron.schedule(
                        'qb-sync-log-cleanup',
                        '0 3 * * 0',  -- Every Sunday at 3am
                        $$DELETE FROM qb_sync_log WHERE initiated_at < NOW() - INTERVAL '90 days'$$
                    );
                END IF;
            END
            $$;
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS qb_sync_log`);
  }
}
