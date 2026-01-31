#!/usr/bin/env tsx

/**
 * PHASE 0: Database Backup
 * Creates a full JSON backup of critical tables before migration
 */

import { Client } from 'pg'
import { writeFileSync } from 'fs'

async function createBackup() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('\n📦 Creating database backup...\n')

        const backup: any = {
            timestamp: new Date().toISOString(),
            tables: {}
        }

        // Backup product_category table
        console.log('Backing up product_category...')
        const categories = await client.query('SELECT * FROM product_category ORDER BY id')
        backup.tables.product_category = categories.rows
        console.log(`  ✅ Backed up ${categories.rows.length} categories`)

        // Backup product_category_product junction
        console.log('Backing up product_category_product...')
        const catProducts = await client.query('SELECT * FROM product_category_product')
        backup.tables.product_category_product = catProducts.rows
        console.log(`  ✅ Backed up ${catProducts.rows.length} category-product links`)

        // Backup products with metadata
        console.log('Backing up product metadata...')
        const products = await client.query('SELECT id, metadata FROM product WHERE metadata IS NOT NULL')
        backup.tables.product_metadata = products.rows
        console.log(`  ✅ Backed up ${products.rows.length} products with metadata`)

        // Save to file
        const filename = `category-id-migration-backup-${Date.now()}.json`
        writeFileSync(filename, JSON.stringify(backup, null, 2))

        console.log(`\n✅ Backup created: ${filename}`)
        console.log(`📊 Backup size: ${(Buffer.byteLength(JSON.stringify(backup)) / 1024 / 1024).toFixed(2)} MB\n`)

        // Print summary
        console.log('📋 Backup Summary:')
        console.log(`   Categories: ${backup.tables.product_category.length}`)
        console.log(`   Category-Product Links: ${backup.tables.product_category_product.length}`)
        console.log(`   Products with Metadata: ${backup.tables.product_metadata.length}`)

        // Count categories by type
        const leafCategories = backup.tables.product_category.filter((c: any) =>
            !backup.tables.product_category.some((child: any) => child.parent_category_id === c.id)
        )
        const parentCategories = backup.tables.product_category.filter((c: any) =>
            backup.tables.product_category.some((child: any) => child.parent_category_id === c.id)
        )

        console.log(`   Leaf Categories: ${leafCategories.length}`)
        console.log(`   Parent Categories: ${parentCategories.length}`)
        console.log(`\n✅ Backup complete. Safe to proceed with migration.\n`)

    } catch (error) {
        console.error('❌ Backup failed:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

createBackup()
