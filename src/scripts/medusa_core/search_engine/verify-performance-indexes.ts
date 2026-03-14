#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const EXPECTED_INDEXES = [
    'idx_product_category_product_category_lookup',
    'idx_product_category_product_product_lookup',
    'idx_product_category_parent_lookup',
    'idx_product_variant_product_lookup',
    'idx_inventory_level_inventory_lookup'
];

async function verifyIndexes() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        console.log('🔍 Checking for performance indexes...\n');

        for (const indexName of EXPECTED_INDEXES) {
            const result = await client.query(`
                SELECT 
                    schemaname,
                    tablename,
                    indexname
                FROM pg_indexes
                WHERE indexname = $1
            `, [indexName]);

            if (result.rows.length > 0) {
                const row = result.rows[0];
                console.log(`✅ ${indexName}`);
                console.log(`   Table: ${row.tablename}`);
            } else {
                console.log(`❌ ${indexName} - NOT FOUND`);
            }
        }

        console.log('\n📊 Summary:');
        const totalChecked = EXPECTED_INDEXES.length;
        console.log(`Total indexes checked: ${totalChecked}`);

    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
        throw error;
    } finally {
        await client.end();
    }
}

verifyIndexes().catch(console.error);
