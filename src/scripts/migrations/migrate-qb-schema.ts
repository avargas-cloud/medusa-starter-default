#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function runMigration() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // Create quickbooks_config table
        await client.query(`
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
        console.log('✅ Created quickbooks_config table');

        // Create quickbooks_logs table
        await client.query(`
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
        console.log('✅ Created quickbooks_logs table');

        // Create indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_logs_created_at 
            ON quickbooks_logs(created_at DESC);
        `);
        console.log('✅ Created index: idx_qb_logs_created_at');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_qb_logs_type_status 
            ON quickbooks_logs(type, status);
        `);
        console.log('✅ Created index: idx_qb_logs_type_status');

        // Insert default configuration
        await client.query(`
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
        console.log('✅ Inserted default configuration');

        console.log('\n🎉 Migration completed successfully!\n');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await client.end();
    }
}

runMigration();
