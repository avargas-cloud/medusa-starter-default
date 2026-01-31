#!/usr/bin/env tsx

import { Client } from 'pg'

async function clearSortingOnly() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/medusa-docker'
    })

    try {
        await client.connect()
        console.log('\n🗑️  Removing ONLY sorting_config from LED Strips metadata...\n')

        // Get current metadata
        const result = await client.query(`
            SELECT id, name, metadata FROM product_category 
            WHERE handle = 'led-strips'
        `)

        if (result.rows.length === 0) {
            console.log('❌ LED Strips not found\n')
            return
        }

        const category = result.rows[0]
        const metadata = category.metadata || {}

        console.log(`Found: ${category.name}`)
        console.log(`Current metadata keys: ${Object.keys(metadata).join(', ')}`)

        // Remove ONLY sorting_config, keep everything else
        delete metadata.sorting_config

        // Update with modified metadata
        await client.query(`
            UPDATE product_category 
            SET metadata = $1::jsonb
            WHERE id = $2
        `, [JSON.stringify(metadata), category.id])

        console.log('\n✅ Removed sorting_config')
        console.log(`Remaining metadata keys: ${Object.keys(metadata).join(', ')}`)
        console.log('\n✅ Ready for fresh sorting (prerender preserved)\n')

    } catch (error) {
        console.error('❌ Error:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

clearSortingOnly()
