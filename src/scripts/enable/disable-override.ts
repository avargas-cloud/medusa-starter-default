#!/usr/bin/env tsx
/**
 * Quick script to disable override_inheritance for all categories
 * Sets all categories to inherit filters from parent by default
 */

import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function disableAllOverrides() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // Get all categories with filter_config
        const result = await client.query(`
            SELECT id, name, metadata
            FROM product_category
            WHERE deleted_at IS NULL
              AND metadata ? 'filter_config'
        `);

        console.log(`📋 Found ${result.rows.length} categories with filter_config\n`);

        let updatedCount = 0;

        for (const category of result.rows) {
            const metadata = category.metadata;

            if (metadata.filter_config?.override_inheritance === true) {
                // Update to false
                metadata.filter_config.override_inheritance = false;

                await client.query(`
                    UPDATE product_category
                    SET metadata = $1
                    WHERE id = $2
                `, [JSON.stringify(metadata), category.id]);

                console.log(`✅ ${category.name}: override disabled`);
                updatedCount++;
            }
        }

        console.log(`\n🎉 Complete! Updated ${updatedCount} categories to inherit from parent`);

    } finally {
        await client.end();
    }
}

disableAllOverrides();
