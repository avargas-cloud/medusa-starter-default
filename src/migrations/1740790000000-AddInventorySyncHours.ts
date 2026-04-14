import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds store hours time-window columns to quickbooks_config.
 * Inventory sync only runs between inventory_sync_start_hour and inventory_sync_end_hour (inclusive).
 * Default: 9:00 AM – 6:00 PM (store hours).
 * If both are NULL, the sync runs 24/7 (existing behavior preserved).
 */
export class AddInventorySyncHours1740790000000 implements MigrationInterface {
  name = "AddInventorySyncHours1740790000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE quickbooks_config
                ADD COLUMN IF NOT EXISTS inventory_sync_start_hour SMALLINT DEFAULT 9,
                ADD COLUMN IF NOT EXISTS inventory_sync_end_hour   SMALLINT DEFAULT 18,
                ADD COLUMN IF NOT EXISTS inventory_sync_timezone   VARCHAR(64) DEFAULT 'America/New_York'
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE quickbooks_config
                DROP COLUMN IF EXISTS inventory_sync_start_hour,
                DROP COLUMN IF EXISTS inventory_sync_end_hour,
                DROP COLUMN IF EXISTS inventory_sync_timezone
        `);
  }
}
