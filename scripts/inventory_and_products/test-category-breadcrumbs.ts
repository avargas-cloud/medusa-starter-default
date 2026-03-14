/**
 * Test Category Breadcrumbs & Subcategories
 * 
 * Verifies:
 * 1. Breadcrumbs trail works (recursive traversal)
 * 2. Subcategories are fetched (category_children)
 * 3. Metadata (images) is preserved
 */

export default async function testCategoryBreadcrumbs({ container }: any) {
    const query = container.resolve("query")
    const logger = console

    logger.info("\n🧪 TESTING CATEGORY ENDPOINTS FUNCTIONALITY\n")
    logger.info("=".repeat(70))

    // Test categories at different depths
    const testCategories = [
        { handle: "by-categories", expectedDepth: 1, description: "Root category" },
        { handle: "led-drivers", expectedDepth: 2, description: "Parent category (has children)" },
        { handle: "dimmable-power-supplies", expectedDepth: 3, description: "Leaf category (no children)" }
    ]

    for (const test of testCategories) {
        logger.info(`\n📁 Testing: ${test.description}`)
        logger.info("-".repeat(70))

        try {
            // Find category by handle using query.graph for ALL fields
            const { data: categories } = await query.graph({
                entity: "product_category",
                fields: [
                    "id", "name", "handle", "parent_category_id", "metadata"
                ],
                filters: { handle: test.handle }
            })

            const category = categories?.[0]

            if (!category) {
                logger.error(`❌ Category not found: ${test.handle}`)
                continue
            }

            logger.info(`📊 Category: ${category.name} (${category.id})`)

            // 1. Build & Verify Breadcrumbs
            const breadcrumbs: Array<{ id: string; name: string; handle: string }> = []
            let currentId: string | null = category.id
            let depth = 0
            const MAX_DEPTH = 10

            while (currentId && depth < MAX_DEPTH) {
                const { data: cats } = await query.graph({
                    entity: "product_category",
                    fields: ["id", "name", "handle", "parent_category_id"],
                    filters: { id: currentId }
                })

                const cat = cats?.[0]
                if (!cat) break

                breadcrumbs.unshift({
                    id: cat.id,
                    name: cat.name,
                    handle: cat.handle
                })

                currentId = cat.parent_category_id
                depth++
            }

            logger.info(`\n🍞 Breadcrumbs (${breadcrumbs.length} levels):`)
            breadcrumbs.forEach((crumb, idx) => {
                const indent = "  ".repeat(idx)
                const arrow = idx > 0 ? "└─ " : ""
                logger.info(`${indent}${arrow}${crumb.name} (${crumb.handle})`)
            })

            if (breadcrumbs.length === test.expectedDepth) {
                logger.info(`✅ Breadcrumb depth correct`)
            } else {
                logger.warn(`⚠️  Breadcrumb depth mismatch (expected ${test.expectedDepth}, got ${breadcrumbs.length})`)
            }

            // 2. Fetch & Verify Subcategories (category_children)
            const { data: children } = await query.graph({
                entity: "product_category",
                fields: ["id", "name", "handle", "rank"],
                filters: { parent_category_id: category.id }
            })

            logger.info(`\n📂 Subcategories (${children.length}):`)
            if (children.length > 0) {
                children.slice(0, 3).forEach((child: any) => {
                    logger.info(`  - ${child.name}`)
                })
                if (children.length > 3) logger.info(`  ... and ${children.length - 3} more`)
                logger.info(`✅ Subcategories fetched successfully`)
            } else {
                logger.info(`  (No subcategories - Expected for leaf nodes)`)
            }

            // 3. Verify Metadata (Image)
            const imageUrl = category.metadata?.image?.url
            if (imageUrl) {
                logger.info(`\n�️  Metadata Image: Found`)
                logger.info(`  ${imageUrl.substring(0, 60)}...`)
            } else {
                logger.info(`\n🖼️  Metadata Image: None (or not set)`)
            }

        } catch (error: any) {
            logger.error(`❌ Error logic: ${error.message}`)
        }
    }

    logger.info("\n" + "=".repeat(70))
    logger.info("✅ VERIFICATION COMPLETE\n")
}
