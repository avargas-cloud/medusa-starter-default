import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateQuickBooksSchema1738424400000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create quickbooks_config table
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS quickbooks_config (
                id VARCHAR(255) PRIMARY KEY,
                inventory_interval_minutes INT NOT NULL DEFAULT 30,
                price_interval_minutes INT NOT NULL DEFAULT 1440,
                last_inventory_sync TIMESTAMPTZ,
                last_price_sync TIMESTAMPTZ,
                bridge_url VARCHAR(500) NOT NULL DEFAULT 'https://qb.eptbridge.com',
                api_key VARCHAR(500),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

    // Create quickbooks_logs table
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS quickbooks_logs (
                id VARCHAR(255) PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                status VARCHAR(50) NOT NULL,
                message TEXT,
                details JSONB,
                stats JSONB,
                started_at TIMESTAMPTZ NOT NULL,
                completed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);

    // Create indexes for faster queries
    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_logs_created_at 
            ON quickbooks_logs(created_at DESC);
        `);

    await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_logs_type_status 
            ON quickbooks_logs(type, status);
        `);

    // Insert default configuration
    await queryRunner.query(`
            INSERT INTO quickbooks_config (
                id,
                inventory_interval_minutes,
                price_interval_minutes,
                bridge_url,
                created_at,
                updated_at
            ) VALUES (
                'default',
                30,
                1440,
                'https://qb.eptbridge.com',
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO NOTHING;
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS quickbooks_logs CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS quickbooks_config CASCADE;`);
  }
}
