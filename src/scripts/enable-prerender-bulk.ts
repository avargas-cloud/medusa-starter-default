import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Bulk Enable Prerender for Specific Categories and Products
  * 
 * Run with: npx medusa exec ./src/scripts/enable-prerender-bulk.ts
 */

const TARGET_CATEGORY_NAMES = [
    "Cables",
    "LED Controllers",
    "LED Channels",
    "LED Drivers",
    "LED Strips",
    "Linear Lighting Accessories",
    "Backlighting"
]

export default async function enablePrerenderBulk({ container }: ExecArgs) {
    console.log("🚀 Starting bulk prerender enable script...\n")

    const query = container.resolve("query")

    try {
        // Step 1: Find target categories by name
        console.log("📂 Step 1: Finding target categories by name...")

        const { data: rootCategories } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle"],
            filters: {
                name: TARGET_CATEGORY_NAMES
            },
            pagination: { take: 100 }
        })

        if (!rootCategories || rootCategories.length === 0) {
            console.log("❌ No matching categories found!")
            return
        }

        console.log(`✅ Found ${rootCategories.length} root categories:\n`)
        rootCategories.forEach(cat => console.log(`   - ${cat.name} (${cat.id})`))

        // Step 2: Get ALL categories to build hierarchy
        console.log("\n📂 Step 2: Fetching all categories to find descendants...")

        const { data: allCats } = await query.graph({
            entity: "product_category",
            fields: ["id", "name", "handle", "parent_category_id"],
            pagination: { take: 5000 }
        })

        console.log(`✅ Loaded ${allCats.length} total categories`)

        // Build parent-to-children map
        const childrenMap = new Map<string, string[]>()
        for (const cat of allCats) {
            if (cat.parent_category_id) {
                const siblings = childrenMap.get(cat.parent_category_id) || []
                siblings.push(cat.id)
                childrenMap.set(cat.parent_category_id, siblings)
            }
        }

        // Collect all descendants for each root category
        const allCategoryIds = new Set<string>()

        const collectDescendants = (parentId: string) => {
            allCategoryIds.add(parentId)
            const children = childrenMap.get(parentId) || []
            for (const childId of children) {
                collectDescendants(childId)
            }
        }

        for (const rootCat of rootCategories) {
            collectDescendants(rootCat.id)
        }

        console.log(`✅ Total categories (including descendants): ${allCategoryIds.size}`)


        // Step 3: Update all categories
        console.log("\n🔄 Step 3: Updating categories metadata.prerender = true...")
        const productService = container.resolve(Modules.PRODUCT)
        let categoriesUpdated = 0

        for (const categoryId of allCategoryIds) {
            await productService.updateProductCategories(categoryId, {
                metadata: { prerender: true }
            })
            categoriesUpdated++

            if (categoriesUpdated % 10 === 0) {
                console.log(`   Updated ${categoriesUpdated}/${allCategoryIds.size} categories...`)
            }
        }

        console.log(`✅ Updated ${categoriesUpdated} categories`)

        // Step 4: Find all products in these categories
        console.log("\n🛍️  Step 4: Finding all products in these categories...")
        const categoryIdsArray = Array.from(allCategoryIds)

        // Query products with category filter
        const { data: products } = await query.graph({
            entity: "product",
            fields: ["id", "title"],
            filters: {
                categories: {
                    id: categoryIdsArray
                }
            },
            pagination: { take: 10000 }
        })

        console.log(`✅ Found ${products.length} products`)


        // Step 5: Update all products
        console.log("\n🔄 Step 5: Updating products metadata.prerender = true...")
        let productsUpdated = 0

        for (const product of products) {
            await productService.updateProducts(product.id, {
                metadata: { prerender: true }
            })
            productsUpdated++

            if (productsUpdated % 50 === 0) {
                console.log(`   Updated ${productsUpdated}/${products.length} products...`)
            }
        }

        console.log(`✅ Updated ${productsUpdated} products`)

        // Summary
        console.log("\n" + "=".repeat(50))
        console.log("📊 SUMMARY")
        console.log("=".repeat(50))
        console.log(`✅ Categories updated: ${categoriesUpdated}`)
        console.log(`✅ Products updated: ${productsUpdated}`)
        console.log(`\nAll items now have metadata.prerender = true`)
        console.log("=".repeat(50))

    } catch (error) {
        console.error("❌ Error:", error)
        throw error
    }
}
