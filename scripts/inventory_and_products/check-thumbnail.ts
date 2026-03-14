#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function check() {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query("SELECT id, name, handle, thumbnail FROM product_category WHERE handle = 'led-strips' LIMIT 1");
    console.log('\n📦 LED Strips Category:');
    console.log('   ID:', r.rows[0].id);
    console.log('   Name:', r.rows[0].name);
    console.log('   Thumbnail:', r.rows[0].thumbnail);
    console.log('');
    await c.end();
}
check();
