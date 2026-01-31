#!/usr/bin/env tsx

/**
 * PHASE 5A: Import Category Image Filenames from WooCommerce
 * Extracts image filenames from WooCommerce and stores in Medusa metadata
 */

import WooCommerceRestApi from "@woocommerce/woocommerce-rest-api"
import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const WooCommerce = new WooCommerceRestApi({
    url: process.env.WC_URL!,
    consumerKey: process.env.WC_CONSUMER_KEY!,
    consumerSecret: process.env.WC_CONSUMER_SECRET!,
    version: "wc/v3"
})

interface WooCategory {
    id: number
    name: string
    slug: string
    image?: {
        id: number
        src: string
        name: string
        alt: string
    } | null
}

async function importCategoryImages() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()

        console.log('\n' + '='.repeat(80))
        console.log('🚀 PHASE 5A: IMPORT CATEGORY IMAGES FROM WOOCOMMERCE')
        console.log('='.repeat(80) + '\n')

        // Step 1: Fetch ALL WooCommerce categories with images
        console.log('📥 Fetching categories from WooCommerce...')

        let page = 1
        let allWooCategories: WooCategory[] = []
        let hasMore = true

        while (hasMore) {
            const response = await WooCommerce.get("products/categories", {
                per_page: 100,
                page: page
            })

            const categories = response.data as WooCategory[]
            allWooCategories.push(...categories)

            console.log(`   Page ${page}: ${categories.length} categories`)

            hasMore = categories.length === 100
            page++
        }

        console.log(`\n✅ Total WooCommerce categories: ${allWooCategories.length}`)

        // Step 2: Filter categories with images
        const categoriesWithImages = allWooCategories.filter(cat => cat.image?.src)
        console.log(`📸 Categories with images: ${categoriesWithImages.length}\n`)

        // Step 3: Get all Medusa categories
        const medusaCategories = await client.query(`
            SELECT id, handle, name FROM product_category
        `)

        const handleToId = new Map<string, string>()
        medusaCategories.rows.forEach(cat => {
            handleToId.set(cat.handle, cat.id)
        })

        console.log(`📊 Medusa categories: ${medusaCategories.rows.length}`)

        // Step 4: Match and prepare updates
        console.log('\n🔗 Matching categories...\n')

        const updates: Array<{
            medusaId: string
            name: string
            imageUrl: string
            imageFilename: string
        }> = []

        for (const wooCategory of categoriesWithImages) {
            const medusaId = handleToId.get(wooCategory.slug)

            if (medusaId) {
                const imageUrl = wooCategory.image!.src
                const imageFilename = imageUrl.split('/').pop()?.split('?')[0] || ''

                updates.push({
                    medusaId,
                    name: wooCategory.name,
                    imageUrl,
                    imageFilename
                })

                console.log(`✅ ${wooCategory.name}`)
                console.log(`   Slug: ${wooCategory.slug}`)
                console.log(`   Image: ${imageFilename}`)
            } else {
                console.log(`⚠️  ${wooCategory.name} (slug: ${wooCategory.slug}) - Not found in Medusa`)
            }
        }

        console.log(`\n📊 Matched: ${updates.length}/${categoriesWithImages.length}`)

        if (updates.length === 0) {
            console.log('❌ No matches found. Nothing to update.\n')
            return
        }

        // Step 5: Update Medusa metadata
        console.log('\n💾 Updating Medusa metadata...')
        await client.query('BEGIN')

        try {
            let updated = 0

            for (const update of updates) {
                // Fetch current metadata
                const current = await client.query(`
                    SELECT metadata FROM product_category WHERE id = $1
                `, [update.medusaId])

                const currentMetadata = current.rows[0]?.metadata || {}

                // Add woocommerce_image metadata
                const newMetadata = {
                    ...currentMetadata,
                    woocommerce_image: {
                        url: update.imageUrl,
                        filename: update.imageFilename,
                        imported_at: new Date().toISOString()
                    }
                }

                await client.query(`
                    UPDATE product_category
                    SET metadata = $1
                    WHERE id = $2
                `, [JSON.stringify(newMetadata), update.medusaId])

                updated++

                if (updated % 10 === 0) {
                    console.log(`   ✅ ${updated}/${updates.length} updated`)
                }
            }

            await client.query('COMMIT')
            console.log(`   ✅ All ${updated} categories updated`)

            console.log('\n' + '='.repeat(80))
            console.log('🎉 PHASE 5A COMPLETE - IMAGE METADATA IMPORTED')
            console.log('='.repeat(80))
            console.log(`\n📊 Summary:`)
            console.log(`   WooCommerce categories processed: ${allWooCategories.length}`)
            console.log(`   Categories with images: ${categoriesWithImages.length}`)
            console.log(`   Matched with Medusa: ${updates.length}`)
            console.log(`   Metadata updated: ${updated}`)

            console.log(`\n📝 Next Step:`)
            console.log(`   Run Phase 5B to find images in MinIO and assign thumbnails`)
            console.log(`   Command: npx tsx migration-phase-5b-assign-thumbnails.ts\n`)

        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        }

    } catch (error) {
        console.error('\n❌ Error:', (error as Error).message)
        process.exit(1)
    } finally {
        await client.end()
    }
}

importCategoryImages()
