#!/usr/bin/env tsx

/**
 * PHASE 1.5: Migrate "CABLE MODELS" (child of Cables)
 * Tests migrating a child of an already-migrated parent
 */

import { Client } from 'pg'
import { ulid } from 'ulid'

async function migratePhase1_5() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('\n🚀 PHASE 1.5: Migrating "CABLE MODELS" category\n')

        // Step 1: Get category info
        const categoryResult = await client.query(`
            SELECT id, name, handle, parent_category_id, metadata
            FROM product_category
            WHERE id = 'pcat_cable-models'
        `)

        if (categoryResult.rows.length === 0) {
            throw new Error('Category "CABLE MODELS" not found')
        }

        const oldCategory = categoryResult.rows[0]
        console.log('📦 Old Category:')
        console.log(`   Name: ${oldCategory.name}`)
        console.log(`   Old ID: ${oldCategory.id}`)
        console.log(`   Parent ID: ${oldCategory.parent_category_id}`)

        // Step 2: Get product count
        const productsResult = await client.query(`
            SELECT COUNT(*) as count
            FROM product_category_product
            WHERE product_category_id = $1
        `, [oldCategory.id])
        const productCount = parseInt(productsResult.rows[0].count)
        console.log(`   Products: ${productCount}`)

        // Step 3: Generate new ID
        const newId = `pcat_${ulid()}`
        console.log(`\n✨ New ID: ${newId}`)

        // Step 4: Start transaction with DEFERRED FK constraints
        console.log('\n🔒 Starting transaction (FK constraints deferred)...')
        await client.query('BEGIN')
        await client.query('SET CONSTRAINTS ALL DEFERRED')

        try {
            // Step 5: Update category ID
            console.log('📝 Updating category ID...')
            await client.query(`
                UPDATE product_category
                SET id = $1
                WHERE id = $2
            `, [newId, oldCategory.id])
            console.log(`   ✅ Updated category ID`)

            // Step 6: Update product links
            console.log('📝 Updating product links...')
            const updateProducts = await client.query(`
                UPDATE product_category_product
                SET product_category_id = $1
                WHERE product_category_id = $2
                RETURNING product_id
            `, [newId, oldCategory.id])
            console.log(`   ✅ Updated ${updateProducts.rows.length} product links`)

            // Step 7: Verify integrity
            console.log('\n🔍 Verifying integrity...')

            // Check product count
            const verifyProducts = await client.query(`
                SELECT COUNT(*) as count
                FROM product_category_product
                WHERE product_category_id = $1
            `, [newId])
            const newProductCount = parseInt(verifyProducts.rows[0].count)
            console.log(`   Products with new ID: ${newProductCount}`)

            if (newProductCount !== productCount) {
                throw new Error(`Product count mismatch! Expected ${productCount}, got ${newProductCount}`)
            }

            // Check old ID gone
            const verifyOldGone = await client.query(`
                SELECT COUNT(*) as count FROM product_category WHERE id = $1
            `, [oldCategory.id])

            if (parseInt(verifyOldGone.rows[0].count) > 0) {
                throw new Error('Old ID still exists!')
            }
            console.log(`   ✅ Old ID removed`)

            // Check new ID exists
            const verifyNewExists = await client.query(`
                SELECT id, name FROM product_category WHERE id = $1
            `, [newId])

            if (verifyNewExists.rows.length === 0) {
                throw new Error('New ID not found!')
            }
            console.log(`   ✅ New ID exists: ${verifyNewExists.rows[0].name}`)

            // Commit transaction
            console.log('\n✅ All checks passed. Committing transaction...')
            await client.query('COMMIT')
            console.log('✅ Transaction committed (FK constraints verified)')

            // Final summary
            console.log('\n' + '='.repeat(80))
            console.log('✅ PHASE 1.5 MIGRATION SUCCESSFUL')
            console.log('='.repeat(80))
            console.log(`\n📊 Summary:`)
            console.log(`   Category: ${oldCategory.name}`)
            console.log(`   Old ID: ${oldCategory.id}`)
            console.log(`   New ID: ${newId}`)
            console.log(`   Parent: ${oldCategory.parent_category_id} (already migrated in Phase 1)`)
            console.log(`   Products updated: ${productCount}`)
            console.log(`\n📝 Action Required:`)
            console.log(`   1. Refresh admin UI`)
            console.log(`   2. Navigate to "Cables" > "CABLE MODELS"`)
            console.log(`   3. Verify category appears correctly`)
            console.log(`   4. Verify ${productCount} products still linked`)
            console.log(`   5. Check products page shows correct category`)
            console.log(`\n✅ If verification passes, ready for Phase 2 (10 categories)\n`)

        } catch (error) {
            console.log('\n❌ Error during migration. Rolling back...')
            await client.query('ROLLBACK')
            console.log('✅ Rollback complete. Database unchanged.')
            throw error
        }

    } catch (error) {
        console.error('\n❌ Migration failed:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

migratePhase1_5()
