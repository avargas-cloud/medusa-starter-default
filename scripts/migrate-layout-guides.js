#!/usr/bin/env node
/**
 * scripts/migrate-layout-guides.js
 * Adds the layout_guides column to pos_document_template if it doesn't exist.
 * Run once: node scripts/migrate-layout-guides.js
 */

require('dotenv').config({ path: '.env' })

const { Client } = require('pg')

async function main() {
    const db = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('railway') || process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false,
    })
    await db.connect()
    console.log('Connected to DB:', process.env.DATABASE_URL?.split('@')[1] ?? 'local')
    const res = await db.query(`
        ALTER TABLE pos_document_template
        ADD COLUMN IF NOT EXISTS layout_guides JSONB DEFAULT '[]'
    `)
    console.log('Migration result:', res.command)
    await db.end()
    console.log('Done.')
}

main().catch(e => {
    console.error('Migration failed:', e.message)
    process.exit(1)
})
