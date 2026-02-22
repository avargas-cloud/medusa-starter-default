import { MigrationInterface, QueryRunner } from "typeorm"

/**
 * Adds last_customer_sync column to quickbooks_config.
 * Needed by the quickbooks-auto-sync job to track when the last customer sync ran.
 */
export class AddLastCustomerSync1738428000000 implements MigrationInterface {
    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "quickbooks_config"
            ADD COLUMN IF NOT EXISTS "last_customer_sync" TIMESTAMP WITH TIME ZONE
        `)
        console.log("✅ Migration: last_customer_sync column added to quickbooks_config")
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TABLE "quickbooks_config"
            DROP COLUMN IF EXISTS "last_customer_sync"
        `)
    }
}
