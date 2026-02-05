#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function checkFilterConfig() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    try {
        await client.connect();

        const result = await client.query(`
            SELECT name, metadata->'filter_config' as filter_config
            FROM product_category
            WHERE handle = 'by-categories'
            LIMIT 1
        `);

        const config = result.rows[0].filter_config;
        console.log('\n=== BY CATEGORIES filter_config structure ===\n');
        console.log('Has available_filters:', 'available_filters' in config);
        console.log('Has active_filters:', 'active_filters' in config);
        console.log('available_filters length:', config.available_filters?.length || 0);
        console.log('active_filters length:', config.active_filters?.length || 0);
        console.log('\n');

    } finally {
        await client.end();
    }
}

checkFilterConfig();
