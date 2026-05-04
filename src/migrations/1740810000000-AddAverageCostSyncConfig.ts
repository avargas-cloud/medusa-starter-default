import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds a dedicated QuickBooks average-cost sync schedule and timestamp.
 * The sync writes QB AverageCost into product_variant.metadata.qb_avg_cost.
 */
export class AddAverageCostSyncConfig1740810000000
  implements MigrationInterface
{
  name = "AddAverageCostSyncConfig1740810000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quickbooks_config
        ADD COLUMN IF NOT EXISTS average_cost_interval_minutes INTEGER,
        ADD COLUMN IF NOT EXISTS last_average_cost_sync TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS average_cost_respect_hours BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS average_cost_sync_hour SMALLINT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS average_cost_sync_timezone VARCHAR(64) DEFAULT 'America/New_York'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE quickbooks_config
        DROP COLUMN IF EXISTS average_cost_interval_minutes,
        DROP COLUMN IF EXISTS last_average_cost_sync,
        DROP COLUMN IF EXISTS average_cost_respect_hours,
        DROP COLUMN IF EXISTS average_cost_sync_hour,
        DROP COLUMN IF EXISTS average_cost_sync_timezone
    `);
  }
}
