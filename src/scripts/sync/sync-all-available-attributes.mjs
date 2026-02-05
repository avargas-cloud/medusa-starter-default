#!/usr/bin/env node

/**
 * SYNC AVAILABLE ATTRIBUTES FOR ALL CATEGORIES (Internal version)
 * 
 * This version uses internal Medusa services instead of HTTP
 * to avoid authentication issues.
 */

import { Modules } from "@medusajs/utils"
import { MedusaApp } from "@medusajs/modules-sdk"

async function main() {
    console.log('🔄 SYNC AVAILABLE ATTRIBUTES FOR ALL CATEGORIES\n')

    try {
        // 1. Initialize Medusa app
        const { medusaAppLoader } = await MedusaApp({
            modulesConfig: {}
        })

        const { container } = await medusaAppLoader.load()

        const query = container.resolve('query')
        const productModule = container.resolve(Modules.PRODUCT)
        const knex = container.resolve('__pg_connection__')

        console.log('📦 Fetching categories...')

        // 2. Fetch all categories
        const { data: categories } = await query.graph({
            entity: 'product_category',
            fields: ['id', 'name', 'handle', 'metadata'],
            filters: {}
        })

        console.log(`   Found ${categories.length} categories\n`)
        console.log('🔧 Syncing attributes...\n')

        let synced = 0
        let skipped = 0
        let failed = 0

        for (const category of categories) {
            const hasAvailableAttrs = category.metadata?.available_attributes !== undefined
            const status = hasAvailableAttrs ? '✅' : '❌'

            try {
                console.log(`   ${status} ${category.name} (${category.handle})`)

                // Fetch PUBLISHED products in this category
                const allProducts = await productModule.listProducts(
                    { status: ['published'] },
                    { relations: ['categories'], take: 10000 }
                )

                const products = allProducts.filter(p =>
                    p.categories?.some((cat) => cat.id === category.id)
                )

                if (products.length === 0) {
                    // Update to empty array
                    await knex('product_category')
                        .where({ id: category.id })
                        .update({
                            metadata: JSON.stringify({
                                ...category.metadata,
                                available_attributes: []
                            }),
                            updated_at: new Date()
                        })

                    console.log(`      → No products (set to [])`)
                    skipped++
                    continue
                }

                // Extract attribute keys
                const productIds = products.map(p => p.id)
                const uniqueAttrKeys = new Set()

                for (const productId of productIds) {
                    const { data: links } = await query.graph({
                        entity: 'product_attribute_value',
                        fields: ['attribute_value_id'],
                        filters: { product_id: productId }
                    })

                    if (links && links.length > 0) {
                        const valueIds = links.map(l => l.attribute_value_id)
                        const { data: values } = await query.graph({
                            entity: 'attribute_value',
                            fields: ['attribute_key.id'],
                            filters: { id: valueIds }
                        })

                        values.forEach(val => {
                            if (val.attribute_key?.id) {
                                uniqueAttrKeys.add(val.attribute_key.id)
                            }
                        })
                    }
                }

                const attributeKeysArray = Array.from(uniqueAttrKeys)

                // Update category metadata
                await knex('product_category')
                    .where({ id: category.id })
                    .update({
                        metadata: JSON.stringify({
                            ...category.metadata,
                            available_attributes: attributeKeysArray
                        }),
                        updated_at: new Date()
                    })

                console.log(`      → Synced ${attributeKeysArray.length} attributes from ${products.length} products`)
                synced++

            } catch (error) {
                console.log(`      → ❌ FAILED: ${error.message}`)
                failed++
            }
        }

        console.log('\n📈 SUMMARY:')
        console.log(`   ✅ Synced: ${synced}`)
        console.log(`   ⏭️  Skipped: ${skipped} (empty categories)`)
        console.log(`   ❌ Failed: ${failed}`)
        console.log(`   📊 Total: ${categories.length}`)

        console.log('\n🎉 DONE!\n')
        console.log('💡 TIP: Now when you open Admin → Filters, you\'ll see only relevant attributes')
        console.log('   for each category instead of all system attributes.\n')

        process.exit(0)

    } catch (error) {
        console.error('❌ ERROR:', error.message)
        console.error(error.stack)
        process.exit(1)
    }
}

main()
