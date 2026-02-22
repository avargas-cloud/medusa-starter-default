#!/usr/bin/env tsx
import { Client } from 'pg'
import dotenv from 'dotenv'
dotenv.config()

async function setAllCategoriesToIncludeDescendants() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('✅ Connected to database\n')

        // Get all categories
        const result = await client.query(`
            SELECT id, name, metadata
            FROM product_category
            WHERE deleted_at IS NULL
            ORDER BY name
        `)

        console.log(`📋 Found ${result.rows.length} categories\n`)

        let updated = 0
        let skipped = 0

        for (const category of result.rows) {
            const currentMetadata = category.metadata || {}
            const currentValue = currentMetadata.include_descendants_tree

            // Only update if not already set to true
            if (currentValue === true) {
                console.log(`⏭️  ${category.name} - Already set to true`)
                skipped++
                continue
            }

            // Update metadata
            const newMetadata = {
                ...currentMetadata,
                include_descendants_tree: true
            }

            await client.query(`
                UPDATE product_category
                SET metadata = $1
                WHERE id = $2
            `, [JSON.stringify(newMetadata), category.id])

            console.log(`✅ ${category.name} - Set to true (was: ${currentValue ?? 'undefined'})`)
            updated++
        }

        console.log(`\n📊 Summary:`)
        console.log(`   Updated: ${updated}`)
        console.log(`   Skipped: ${skipped}`)
        console.log(`   Total: ${result.rows.length}`)

    } catch (error) {
        console.error('❌ Error:', error)
        throw error
    } finally {
        await client.end()
    }
}

setAllCategoriesToIncludeDescendants()
