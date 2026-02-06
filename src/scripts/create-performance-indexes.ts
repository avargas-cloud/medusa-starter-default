#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function createIndexes() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        console.log('🔨 Creating performance indexes...\n');

        // Index 1: Product-Category relationship (category → products)
        console.log('Creating idx_product_category_product_category_lookup...');
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_category_product_category_lookup 
            ON product_category_product(product_category_id);
        `);
        console.log('✅ Created\n');

        // Index 2: Product-Category relationship (product → categories)
        console.log('Creating idx_product_category_product_product_lookup...');
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_category_product_product_lookup 
            ON product_category_product(product_id);
        `);
        console.log('✅ Created\n');

        // Index 3: Category tree traversal (parent lookups)
        console.log('Creating idx_product_category_parent_lookup...');
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_category_parent_lookup 
            ON product_category(parent_category_id) 
            WHERE parent_category_id IS NOT NULL;
        `);
        console.log('✅ Created\n');

        // Index 4: Product variant pricing
        console.log('Creating idx_product_variant_product_lookup...');
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_product_variant_product_lookup 
            ON product_variant(product_id);
        `);
        console.log('✅ Created\n');

        // Index 5: Inventory level lookups
        console.log('Creating idx_inventory_level_inventory_lookup...');
        await client.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_inventory_level_inventory_lookup 
            ON inventory_level(inventory_item_id);
        `);
        console.log('✅ Created\n');

        console.log('📊 Verifying created indexes...\n');

        const result = await client.query(`
            SELECT tablename, indexname 
            FROM pg_indexes 
            WHERE indexname LIKE 'idx_%lookup%' 
            ORDER BY tablename, indexname;
        `);

        console.log('✅ Found', result.rows.length, 'indexes:');
        result.rows.forEach(row => {
            console.log(`   - ${row.indexname} on ${row.tablename}`);
        });

        console.log('\n✅ All indexes created successfully!');

    } catch (error) {
        console.error('❌ Error:', (error as Error).message);
        throw error;
    } finally {
        await client.end();
    }
}

createIndexes().catch(console.error);
