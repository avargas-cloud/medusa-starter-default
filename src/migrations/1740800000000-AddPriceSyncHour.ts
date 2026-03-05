import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Adds price_sync_hour to quickbooks_config.
 * This allows the admin to configure the exact hour of day for the daily price sync.
 * Range: 0–23 (UTC). Default: 0 = midnight UTC.
 *
 * Also adds price_sync_timezone for future timezone support.
 */
export class AddPriceSyncHour1740800000000 implements MigrationInterface {
    name = "AddPriceSyncHour1740800000000"

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE quickbooks_config
                ADD COLUMN IF NOT EXISTS price_sync_hour SMALLINT DEFAULT 0,
                ADD COLUMN IF NOT EXISTS price_sync_timezone VARCHAR(64) DEFAULT 'America/New_York'
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE quickbooks_config
                DROP COLUMN IF EXISTS price_sync_hour,
                DROP COLUMN IF EXISTS price_sync_timezone
        `)
    }
}
