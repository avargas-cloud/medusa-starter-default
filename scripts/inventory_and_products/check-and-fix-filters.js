#!/usr/bin/env node

/**
 * Diagnostic and Fix Script for Category Filters
 * 
 * This script:
 * 1. Checks if led-strips-white category has filters in metadata
 * 2. If not, shows what's missing
 * 3. Provides SQL query to check database directly
 */

const { Client } = require('pg');

async function main() {
    console.log('🔍 Checking category metadata for: led-strips-white\n');

    // Connect to database
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // Query category metadata
        const result = await client.query(`
            SELECT 
                id, 
                handle, 
                name,
                metadata
            FROM product_category 
            WHERE handle = 'led-strips-white'
        `);

        if (result.rows.length === 0) {
            console.error('❌ Category "led-strips-white" not found!');
            process.exit(1);
        }

        const category = result.rows[0];
        console.log('📦 Category Found:');
        console.log(`   ID: ${category.id}`);
        console.log(`   Handle: ${category.handle}`);
        console.log(`   Name: ${category.name}`);
        console.log();

        const metadata = category.metadata || {};

        console.log('📊 Metadata Analysis:');
        console.log(`   Has metadata: ${Object.keys(metadata).length > 0 ? '✅ YES' : '❌ NO'}`);
        console.log(`   Has filter_config: ${metadata.filter_config ? '✅ YES' : '❌ NO'}`);
        console.log(`   Has filters: ${metadata.filters ? '✅ YES' : '❌ NO'}`);
        console.log(`   Has filters_metadata: ${metadata.filters_metadata ? '✅ YES' : '❌ NO'}`);
        console.log();

        if (metadata.filters) {
            console.log(`   ✅ Filters count: ${metadata.filters.length}`);
            console.log(`   Filters:`, JSON.stringify(metadata.filters, null, 2));
        } else {
            console.log('   ❌ NO FILTERS IN METADATA');
            console.log();
            console.log('🔧 To fix this, you need to:');
            console.log('   1. Go to Admin UI → Filters page');
            console.log('   2. Select "led-strips-white" category');
            console.log('   3. Choose which attributes to use as filters');
            console.log('   4. Click "Generate Snapshot"');
            console.log();
            console.log('   OR use the API:');
            console.log(`   curl -X POST http://localhost:9000/admin/product-categories/${category.id}/generate-filters \\`);
            console.log('     -H "Content-Type: application/json" \\');
            console.log('     -d \'{"active_filters": ["attr_id_1", "attr_id_2"], "override_inheritance": true}\'');
        }

        console.log();
        console.log('📋 Full metadata:');
        console.log(JSON.stringify(metadata, null, 2));

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

main();
