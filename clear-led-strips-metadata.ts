#!/usr/bin/env tsx

import { Client } from 'pg'

async function clearMetadata() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/medusa-docker'
    })

    try {
        await client.connect()
        console.log('\n🗑️  Clearing metadata for LED Strips...\n')

        // Find LED Strips category
        const findResult = await client.query(`
            SELECT id, name FROM product_category 
            WHERE handle = 'led-strips'
        `)

        if (findResult.rows.length === 0) {
            console.log('❌ LED Strips category not found\n')
            return
        }

        const category = findResult.rows[0]
        console.log(`Found: ${category.name} (${category.id})`)

        // Clear metadata (set to empty object)
        const updateResult = await client.query(`
            UPDATE product_category 
            SET metadata = '{}'::jsonb
            WHERE id = $1
            RETURNING id, name, metadata
        `, [category.id])

        console.log('\n✅ Metadata cleared!')
        console.log('New metadata:', updateResult.rows[0].metadata)
        console.log('\n✅ Ready for fresh sorting configuration\n')

    } catch (error) {
        console.error('❌ Error:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

clearMetadata()
