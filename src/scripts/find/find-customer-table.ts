#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function findCustomerTable() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    });

    try {
        await client.connect();
        console.log('✅ Connected to database\n');

        // Find all tables with "customer" in the name
        console.log('🔍 Looking for customer-related tables...');
        const tables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE '%customer%'
            ORDER BY table_name
        `);

        console.log(`Found ${tables.rows.length} customer-related tables:`);
        tables.rows.forEach(row => console.log(`   - ${row.table_name}`));
        console.log('');

        // Check columns for each table
        for (const table of tables.rows) {
            const tableName = table.table_name;
            console.log(`📋 Columns in ${tableName}:`);

            const columns = await client.query(`
                SELECT column_name, data_type
                FROM information_schema.columns 
                WHERE table_name = $1
                AND column_name LIKE '%default%'
                ORDER BY column_name
            `, [tableName]);

            if (columns.rows.length > 0) {
                columns.rows.forEach(col => {
                    console.log(`   ✅ ${col.column_name} (${col.data_type})`);
                });
            } else {
                console.log(`   (no default-related columns)`);
            }
            console.log('');
        }

    } catch (error) {
        console.error('❌ Query failed:', error);
        throw error;
    } finally {
        await client.end();
    }
}

findCustomerTable();
