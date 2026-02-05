#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function checkSchema() {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();

    // Check schema
    const schema = await c.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'product_category' 
        ORDER BY ordinal_position
    `);

    console.log('\n📋 TABLE: product_category');
    console.log('='.repeat(50));
    schema.rows.forEach(col => {
        const marker = col.column_name === 'thumbnail' ? ' ← ⭐ FOUND!' : '';
        console.log(`  ${col.column_name.padEnd(30)} ${col.data_type}${marker}`);
    });

    // Check if LED Strips has thumbnail
    const led = await c.query(`
        SELECT id, name, thumbnail 
        FROM product_category 
        WHERE handle = 'led-strips'
    `);

    console.log('\n📦 LED Strips Category:');
    console.log('='.repeat(50));
    console.log('  ID:', led.rows[0].id);
    console.log('  Name:', led.rows[0].name);
    console.log('  Thumbnail:', led.rows[0].thumbnail);
    console.log('');

    await c.end();
}

checkSchema();
