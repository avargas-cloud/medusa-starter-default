#!/usr/bin/env tsx

/**
 * ☢️ TRUE NUCLEAR SYNC - DRY RUN ☢️
 * 
 * Shows what WOULD happen without making changes
 */

import { MedusaContainer } from "@medusajs/framework/types"

export default async function ({ container }: { container: MedusaContainer }) {
    const query = container.resolve("query") as any
    const knex = container.resolve("__pg_connection__") as any

    console.log('\n')
    console.log('🔬 DRY RUN - TRUE NUCLEAR SYNC')
    console.log('═'.repeat(80))
    console.log('⚠️  NO CHANGES WILL BE MADE - REPORTING ONLY')
    console.log('═'.repeat(80))
    console.log('\n')

    try {
        // Get ALL categories
        const { data: allCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "handle", "name", "parent_category_id", "metadata"],
            filters: {}
        })

        console.log(`📦 Found ${allCategories.length} total categories\n`)

        // Helper
        function getDescendants(categoryId: string): string[] {
            const descendants: string[] = []
            for (const cat of allCategories) {
                if (cat.parent_category_id === categoryId) {
                    descendants.push(cat.id)
                    descendants.push(...getDescendants(cat.id))
                }
            }
            return descendants
        }

        let wouldConfigure = 0
        let wouldSkip = 0
        let alreadyConfigured = 0

        console.log('📊 ANALYSIS:\n')

        for (let i = 0; i < allCategories.length; i++) {
            const category = allCategories[i]

            // Parse metadata
            let metadata: any = {}
            try {
                metadata = typeof category.metadata === 'string'
                    ? JSON.parse(category.metadata)
                    : (category.metadata || {})
            } catch (e) {
                metadata = {}
            }

            // Check if already configured
            if (metadata?.filter_config?.active_filters?.length > 0) {
                alreadyConfigured++
                console.log(`✅ [${i + 1}/${allCategories.length}] ${category.name} - Already has ${metadata.filter_config.active_filters.length} filters`)
                continue
            }

            const includeDescendants = metadata?.include_descendants_tree ?? true
            const categoryIdsToScan = includeDescendants
                ? [category.id, ...getDescendants(category.id)]
                : [category.id]

            // Get products
            const { data: products } = await query.graph({
                entity: "product",
                fields: ["id"],
                filters: {
                    status: "published",
                    categories: { id: categoryIdsToScan }
                }
            })

            if (!products || products.length === 0) {
                wouldSkip++
                console.log(`⊘  [${i + 1}/${allCategories.length}] ${category.name} - No products, WOULD SKIP`)
                continue
            }

            const productIds = products.map((p: any) => p.id)

            // Get attributes using the CORRECT link table
            const attributeRows = await knex('attribute_value as av')
                .join('product_product_productattributes_attribute_value as link',
                    'av.id', 'link.attribute_value_id')
                .whereIn('link.product_id', productIds)
                .select('av.attribute_key_id')
                .distinct()

            const uniqueAttrIds = attributeRows.map((row: any) => row.attribute_key_id)

            if (uniqueAttrIds.length === 0) {
                wouldSkip++
                console.log(`⊘  [${i + 1}/${allCategories.length}] ${category.name} - ${products.length} products but NO attributes, WOULD SKIP`)
                continue
            }

            wouldConfigure++
            console.log(`🆕 [${i + 1}/${allCategories.length}] ${category.name} - WOULD CONFIGURE ${uniqueAttrIds.length} filters from ${products.length} products`)
        }

        console.log('\n')
        console.log('═'.repeat(80))
        console.log('📊 DRY RUN SUMMARY')
        console.log('═'.repeat(80))
        console.log(`Total categories: ${allCategories.length}`)
        console.log(`Already configured: ${alreadyConfigured} ✅`)
        console.log(`Would configure: ${wouldConfigure} 🆕`)
        console.log(`Would skip (no products/attrs): ${wouldSkip} ⊘`)
        console.log('')
        console.log(`💾 If run for real:`)
        console.log(`   Phase 1: Would configure ${wouldConfigure} categories`)
        console.log(`   Phase 2: Would generate filters for ${alreadyConfigured + wouldConfigure} categories`)
        console.log('')
        console.log('⚠️  NO CHANGES WERE MADE - This was a dry run')
        console.log('')

    } catch (error: any) {
        console.error('\n❌ DRY RUN ERROR:', error.message)
        console.error(error.stack)
        throw error
    }
}
