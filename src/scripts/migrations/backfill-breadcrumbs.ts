import { Modules } from "@medusajs/framework/utils"
import { buildCategoryBreadcrumbsWorkflow } from "../workflows/build-category-breadcrumbs-workflow"

type BreadcrumbItem = {
    id: string
    name: string
    handle: string
}

/**
 * Calculate category depth by traversing parent chain
 */
async function getCategoryDepth(query: any, categoryId: string): Promise<number> {
    let depth = 0
    let currentId = categoryId
    const MAX_DEPTH = 10 // Safety limit

    while (currentId && depth < MAX_DEPTH) {
        const { data } = await query.graph({
            entity: "product_category",
            fields: ["id", "parent_category_id"],
            filters: { id: currentId }
        })

        if (!data?.[0]) break

        currentId = data[0].parent_category_id
        depth++
    }

    return depth
}

/**
 * Backfill Breadcrumbs Script - Two Phase Approach
 * 
 * PHASE 1: Auto-select deepest category as primary for products WITHOUT primary_category_id
 * PHASE 2: Generate breadcrumbs for products WITH primary_category_id but missing breadcrumbs
 * 
 * Usage: yarn medusa exec ./src/scripts/backfill-breadcrumbs.ts
 */
export default async function backfillBreadcrumbs({ container }) {
    const productModule = container.resolve(Modules.PRODUCT)
    const query = container.resolve("query")
    const logger = container.resolve("logger")

    logger.info("[Backfill] Starting two-phase breadcrumbs backfill...")

    try {
        // Fetch ALL products
        const { data: allProducts } = await query.graph({
            entity: "product",
            fields: ["id", "title", "metadata"],
        })

        logger.info(`[Backfill] Found ${allProducts.length} total products`)

        let phase1Count = 0
        let phase2Count = 0
        let errorCount = 0

        // =================================================================
        // PHASE 1: Auto-select deepest category as primary
        // =================================================================
        logger.info("\n[Phase 1] Auto-selecting deepest categories as primary...")

        const productsWithoutPrimary = allProducts.filter(
            (p: any) => !p.metadata?.primary_category_id
        )

        logger.info(`[Phase 1] ${productsWithoutPrimary.length} products need primary category selection`)

        for (const product of productsWithoutPrimary) {
            try {
                // Fetch product categories using query.graph
                const { data: productWithCategories } = await query.graph({
                    entity: "product",
                    fields: ["id", "title", "categories.*"],
                    filters: { id: product.id }
                })

                if (!productWithCategories?.[0]?.categories || productWithCategories[0].categories.length === 0) {
                    logger.warn(`  ⚠️  ${product.title} - No categories assigned, skipping`)
                    continue
                }

                const categories = productWithCategories[0].categories

                // Calculate depth for each category
                const categoryDepths = await Promise.all(
                    categories.map(async (cat: any) => ({
                        id: cat.id,
                        name: cat.name,
                        depth: await getCategoryDepth(query, cat.id)
                    }))
                )

                // Select the DEEPEST category (most specific, lowest in hierarchy)
                const deepestCategory = categoryDepths.reduce((prev, curr) =>
                    curr.depth > prev.depth ? curr : prev
                )

                // Generate breadcrumbs for this category
                const { result } = await buildCategoryBreadcrumbsWorkflow(container).run({
                    input: { categoryId: deepestCategory.id }
                })

                const breadcrumbs = result as BreadcrumbItem[]

                // Update product with BOTH primary_category_id AND breadcrumbs
                await productModule.updateProducts(product.id, {
                    metadata: {
                        ...product.metadata,
                        primary_category_id: deepestCategory.id,
                        main_category_breadcrumbs: breadcrumbs
                    }
                })

                phase1Count++
                logger.info(
                    `  ✅ [${phase1Count}] ${product.title} → ${deepestCategory.name} (depth: ${deepestCategory.depth}, breadcrumbs: ${breadcrumbs.length})`
                )
            } catch (error: any) {
                errorCount++
                logger.error(`  ❌ Failed for ${product.title}:`, error.message)
            }
        }

        // =================================================================
        // PHASE 2: Generate breadcrumbs for products WITH primary but NO breadcrumbs
        // =================================================================
        logger.info("\n[Phase 2] Generating breadcrumbs for products with primary_category_id...")

        const productsNeedingBreadcrumbs = allProducts.filter(
            (p: any) =>
                p.metadata?.primary_category_id &&
                !p.metadata?.main_category_breadcrumbs
        )

        logger.info(`[Phase 2] ${productsNeedingBreadcrumbs.length} products need breadcrumb generation`)

        for (const product of productsNeedingBreadcrumbs) {
            try {
                const categoryId = product.metadata.primary_category_id as string

                // Generate breadcrumbs
                const { result } = await buildCategoryBreadcrumbsWorkflow(container).run({
                    input: { categoryId }
                })

                const breadcrumbs = result as BreadcrumbItem[]

                // Update product metadata
                await productModule.updateProducts(product.id, {
                    metadata: {
                        ...product.metadata,
                        main_category_breadcrumbs: breadcrumbs
                    }
                })

                phase2Count++
                logger.info(`  ✅ [${phase2Count}] ${product.title} (${breadcrumbs.length} levels)`)
            } catch (error: any) {
                errorCount++
                logger.error(`  ❌ Failed for ${product.title}:`, error.message)
            }
        }

        // =================================================================
        // SUMMARY
        // =================================================================
        logger.info(`\n========================================`)
        logger.info(`[Backfill] Complete!`)
        logger.info(`========================================`)
        logger.info(`  Phase 1 (Auto-select + breadcrumbs): ${phase1Count} products`)
        logger.info(`  Phase 2 (Generate breadcrumbs only): ${phase2Count} products`)
        logger.info(`  Total Updated: ${phase1Count + phase2Count}`)
        logger.info(`  Errors: ${errorCount}`)
        logger.info(`  Already Complete: ${allProducts.length - productsWithoutPrimary.length - productsNeedingBreadcrumbs.length}`)
    } catch (error: any) {
        logger.error("[Backfill] Fatal error:", error.message)
        throw error
    }
}
