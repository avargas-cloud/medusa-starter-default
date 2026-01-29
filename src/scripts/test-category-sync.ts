/**
 * Manual test script to syncall category attributes
 * Run with: npx medusa exec ./src/scripts/test-category-sync.ts
 */

import { MedusaContainer } from "@medusajs/framework/types"

export default async function (container: MedusaContainer) {
    console.log("🧪 Testing category attributes sync...\n")

    const productModule = container.resolve("product")
    const productCategoryService = container.resolve("productCategory")

    // Find "WHITE LED STRIPS" category
    const categories = await productCategoryService.listProductCategories(
        { handle: "led-strips-white" },
        { select: ["id", "name", "handle", "metadata"] }
    )

    if (categories.length === 0) {
        console.log("❌ Category 'led-strips-white' not found")
        console.log("\n📋 Available categories:")
        const allCats = await productCategoryService.listProductCategories({}, { select: ["handle", "name"], take: 20 })
        allCats.forEach(c => console.log(`  - ${c.handle} (${c.name})`))
        return
    }

    const category = categories[0]
    console.log(`✅ Found category: ${category.name} (${category.id})`)
    console.log(`📦 Current metadata:`, JSON.stringify(category.metadata, null, 2))

    // Get products in this category
    const products = await productModule.listProducts(
        { category_id: [category.id] },
        { relations: ["variants"], take: 100 }
    )

    console.log(`\n📦 Found ${products.length} products in category`)

    if (products.length === 0) {
        console.log("⚠️  No products in category - cannot sync")
        return
    }

    // Extract attribute keys
    const uniqueAttrKeys = new Set<string>()

    for (const product of products) {
        console.log(`\n  Product: ${product.title}`)

        // Check product metadata
        if (product.metadata?.attributes) {
            const attrKeys = Object.keys(product.metadata.attributes)
            console.log(`    Product attributes:`, attrKeys)
            attrKeys.forEach(k => uniqueAttrKeys.add(k))
        }

        // Check variant metadata
        if (product.variants) {
            product.variants.forEach((variant: any, idx: number) => {
                if (variant.metadata?.attributes) {
                    const variantAttrKeys = Object.keys(variant.metadata.attributes)
                    console.log(`    Variant ${idx} attributes:`, variantAttrKeys)
                    variantAttrKeys.forEach(k => uniqueAttrKeys.add(k))
                }
            })
        }
    }

    console.log(`\n📊 Total unique attribute keys found: ${uniqueAttrKeys.size}`)
    console.log(`   Keys:`, Array.from(uniqueAttrKeys))

    // Update category
    console.log(`\n🔄 Updating category metadata...`)

    await productCategoryService.updateProductCategories(category.id, {
        metadata: {
            ...(category.metadata || {}),
            available_attributes: Array.from(uniqueAttrKeys)
        }
    })

    // Verify update
    const [updated] = await productCategoryService.listProductCategories(
        { id: [category.id] },
        { select: ["id", "name", "metadata"] }
    )

    console.log(`\n✅ Category updated!`)
    console.log(`📦 New metadata:`, JSON.stringify(updated.metadata, null, 2))
    console.log(`\n✨ Sync complete!`)
}
