#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function getPublishableKey() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();

        const result = await client.query(`
            SELECT id, name 
            FROM publishable_api_key 
            WHERE deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            console.log('❌ No publishable API key found');
            console.log('Creating one...');

            const createResult = await client.query(`
                INSERT INTO publishable_api_key (id, name, created_at, updated_at)
                VALUES ('pk_test', 'Test Key', NOW(), NOW())
                RETURNING id
            `);

            console.log('✅ Created:', createResult.rows[0].id);
            return createResult.rows[0].id;
        }

        console.log('✅ Found publishable key:', result.rows[0].id);
        return result.rows[0].id;

    } finally {
        await client.end();
    }
}

getPublishableKey();
