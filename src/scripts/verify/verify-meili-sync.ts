#!/usr/bin/env tsx
/**
 * Verify MeiliSearch Sync: Compare timestamps between Medusa DB and MeiliSearch
 * 
 * Usage: npx -y tsx verify-meili-sync.ts [productId]
 */

import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const PRODUCT_ID = process.argv[2] || 'product_01KGAX7RCS2MQPQDDMVQSZCJGC'

async function verifySync() {
    // Dynamic import for ESM compatibility
    const { MeiliSearch } = await import('meilisearch')

    const pgClient = new Client({ connectionString: process.env.DATABASE_URL })
    const meiliClient = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!
    })

    try {
        await pgClient.connect()
        console.log('✅ Connected to databases\n')

        // 1. Get from Postgres
        const pgResult = await pgClient.query(`
            SELECT id, title, updated_at, created_at
            FROM product
            WHERE id = $1
        `, [PRODUCT_ID])

        if (pgResult.rows.length === 0) {
            console.log('❌ Product not found in Postgres')
            return
        }

        const pgProduct = pgResult.rows[0]
        const pgUpdatedAt = new Date(pgProduct.updated_at).getTime()

        console.log('📦 POSTGRES (Source of Truth):')
        console.log(`   ID: ${pgProduct.id}`)
        console.log(`   Title: ${pgProduct.title}`)
        console.log(`   Updated: ${pgProduct.updated_at}`)
        console.log(`   Timestamp: ${pgUpdatedAt}`)
        console.log('')

        // 2. Get from MeiliSearch
        const productsIndex = meiliClient.index('products')
        const meiliProduct = await productsIndex.getDocument(PRODUCT_ID) as any

        console.log('🔍 MEILISEARCH (Synced Index):')
        console.log(`   ID: ${meiliProduct.id}`)
        console.log(`   Title: ${meiliProduct.title}`)
        console.log(`   Updated: ${new Date(meiliProduct.updated_at).toISOString()}`)
        console.log(`   Timestamp: ${meiliProduct.updated_at}`)
        console.log('')

        // 3. Compare
        const diff = Math.abs(pgUpdatedAt - meiliProduct.updated_at)
        const diffSeconds = diff / 1000

        console.log('⚖️  COMPARISON:')
        console.log(`   Postgres:    ${pgUpdatedAt}`)
        console.log(`   MeiliSearch: ${meiliProduct.updated_at}`)
        console.log(`   Difference:  ${diff}ms (${diffSeconds}s)`)
        console.log('')

        if (diff === 0) {
            console.log('✅ PERFECT SYNC - Timestamps are identical!')
        } else if (diff < 1000) {
            console.log('✅ EXCELLENT SYNC - Difference < 1 second (rounding)')
        } else if (diff < 5000) {
            console.log('⚠️  ACCEPTABLE SYNC - Difference < 5 seconds')
        } else {
            console.log('❌ OUT OF SYNC - Difference > 5 seconds')
            console.log('   Run: POST /admin/search/products/sync to fix')
        }

    } catch (error: any) {
        console.error('❌ Error:', error.message)
        throw error
    } finally {
        await pgClient.end()
    }
}

verifySync().catch(console.error)
