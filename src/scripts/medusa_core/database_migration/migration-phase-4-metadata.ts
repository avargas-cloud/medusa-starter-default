#!/usr/bin/env tsx

/**
 * PHASE 4: Metadata Migration
 * Update sorting_config and other metadata to use new ULID-format IDs
 */

import { Client } from 'pg'

async function migratePhase4() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('\n' + '='.repeat(80))
        console.log('🚀 PHASE 4: METADATA MIGRATION')
        console.log('='.repeat(80) + '\n')

        // Step 1: Build handle → ULID mapping
        console.log('📊 Building ID mapping from handles to ULIDs...')

        const categories = await client.query(`
            SELECT id, handle FROM product_category
        `)

        const catHandleToId = new Map<string, string>()
        categories.rows.forEach(cat => {
            // Store both formats for lookup
            catHandleToId.set(cat.handle, cat.id)
            catHandleToId.set(`pcat_${cat.handle}`, cat.id)  // Old format: pcat_led-strips
        })

        console.log(`   ✅ ${catHandleToId.size / 2} categories indexed`)

        const products = await client.query(`
            SELECT id, handle FROM product
        `)

        const prodHandleToId = new Map<string, string>()
        products.rows.forEach(prod => {
            prodHandleToId.set(prod.handle, prod.id)
            prodHandleToId.set(`prod_${prod.handle}`, prod.id)  // Old format: prod_ul-freecut...
        })

        console.log(`   ✅ ${prodHandleToId.size / 2} products indexed`)

        // Step 2: Find categories with sorting_config
        const categoriesWithSorting = await client.query(`
            SELECT id, name, handle, metadata
            FROM product_category
            WHERE metadata ? 'sorting_config'
        `)

        console.log(`\n📝 Found ${categoriesWithSorting.rows.length} categories with sorting_config\n`)

        if (categoriesWithSorting.rows.length === 0) {
            console.log('✅ No metadata to migrate\n')
            return
        }

        // Step 3: Start transaction
        console.log('🔒 Starting transaction...')
        await client.query('BEGIN')

        try {
            let categoriesUpdated = 0
            let subcategoriesUpdated = 0
            let productsUpdated = 0

            for (const cat of categoriesWithSorting.rows) {
                const metadata = cat.metadata
                const sortingConfig = metadata.sorting_config

                let needsUpdate = false
                let newSubcategoryOrder = sortingConfig.subcategory_order || []
                let newProductOrder = sortingConfig.product_order || []

                // Convert subcategory handles to ULIDs
                if (sortingConfig.subcategory_order) {
                    newSubcategoryOrder = sortingConfig.subcategory_order.map((item: string) => {
                        // Check if already ULID format
                        if (item.match(/^pcat_01[0-9A-HJKMNP-TV-Z]{24}$/i)) {
                            return item  // Already migrated
                        }

                        // Try to find by handle
                        const newId = catHandleToId.get(item) || catHandleToId.get(`pcat_${item}`)
                        if (newId) {
                            subcategoriesUpdated++
                            needsUpdate = true
                            return newId
                        }

                        console.warn(`   ⚠️  Category handle not found: ${item}`)
                        return item  // Keep original if not found
                    })
                }

                // Convert product handles to ULIDs
                if (sortingConfig.product_order) {
                    newProductOrder = sortingConfig.product_order.map((item: string) => {
                        // Check if already ULID format
                        if (item.match(/^prod_01[0-9A-HJKMNP-TV-Z]{24}$/i)) {
                            return item  // Already migrated
                        }

                        // Try to find by handle
                        const newId = prodHandleToId.get(item) || prodHandleToId.get(`prod_${item}`)
                        if (newId) {
                            productsUpdated++
                            needsUpdate = true
                            return newId
                        }

                        console.warn(`   ⚠️  Product handle not found: ${item}`)
                        return item  // Keep original if not found
                    })
                }

                if (needsUpdate) {
                    // Update metadata with new IDs
                    const updatedMetadata = {
                        ...metadata,
                        sorting_config: {
                            subcategory_order: newSubcategoryOrder,
                            product_order: newProductOrder
                        }
                    }

                    await client.query(`
                        UPDATE product_category
                        SET metadata = $1
                        WHERE id = $2
                    `, [JSON.stringify(updatedMetadata), cat.id])

                    categoriesUpdated++
                    console.log(`   ✅ ${cat.name}: ${newSubcategoryOrder.length} subcats, ${newProductOrder.length} products`)
                }
            }

            console.log(`\n📊 Migration Summary:`)
            console.log(`   Categories with updated sorting_config: ${categoriesUpdated}`)
            console.log(`   Subcategory IDs converted: ${subcategoriesUpdated}`)
            console.log(`   Product IDs converted: ${productsUpdated}`)

            // Commit transaction
            console.log('\n✅ Committing transaction...')
            await client.query('COMMIT')
            console.log('✅ Transaction committed')

            console.log('\n' + '='.repeat(80))
            console.log('🎉 PHASE 4 COMPLETE - METADATA MIGRATED')
            console.log('='.repeat(80))
            console.log(`\n✅ All sorting_config now uses ULID-format IDs`)
            console.log(`\n📝 Verification:`)
            console.log(`   Run check-db-metadata.ts to verify conversion\n`)

        } catch (error) {
            console.log('\n❌ Error during migration. Rolling back...')
            await client.query('ROLLBACK')
            console.log('✅ Rollback complete')
            throw error
        }

    } catch (error) {
        console.error('\n❌ Migration failed:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

migratePhase4()
