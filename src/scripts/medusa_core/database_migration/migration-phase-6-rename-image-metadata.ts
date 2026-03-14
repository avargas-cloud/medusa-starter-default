#!/usr/bin/env tsx
/**
 * Phase 6: Rename Category Image Metadata
 * 
 * Migrates category image data from metadata.woocommerce_image to metadata.image
 * This provides a cleaner, more generic structure since images are now in MinIO
 */

import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

async function migrateImageMetadata() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('✅ Connected to database\n')

        await client.query('BEGIN')

        // Get all categories with woocommerce_image metadata
        const categoriesResult = await client.query(`
            SELECT id, name, metadata
            FROM product_category
            WHERE metadata ? 'woocommerce_image'
        `)

        console.log(`📋 Found ${categoriesResult.rows.length} categories with woocommerce_image metadata\n`)

        let migrated = 0

        for (const cat of categoriesResult.rows) {
            const metadata = cat.metadata as Record<string, any>
            const wooImage = metadata.woocommerce_image

            // Create new metadata structure
            const newMetadata = {
                ...metadata,
                image: {
                    url: wooImage.url || wooImage.filename || null
                }
            }

            // Remove old woocommerce_image field
            delete newMetadata.woocommerce_image

            // Update category
            await client.query(`
                UPDATE product_category
                SET metadata = $1
                WHERE id = $2
            `, [JSON.stringify(newMetadata), cat.id])

            console.log(`✅ ${cat.name}`)
            console.log(`   Old: metadata.woocommerce_image.url = ${wooImage.url}`)
            console.log(`   New: metadata.image.url = ${newMetadata.image.url}`)
            console.log('')

            migrated++
        }

        await client.query('COMMIT')

        console.log(`\n🎉 Migration Complete!`)
        console.log(`   Migrated: ${migrated} categories`)
        console.log(`   metadata.woocommerce_image → metadata.image`)

    } catch (error) {
        await client.query('ROLLBACK')
        console.error('❌ Migration failed:', error)
        throw error
    } finally {
        await client.end()
    }
}

migrateImageMetadata()
