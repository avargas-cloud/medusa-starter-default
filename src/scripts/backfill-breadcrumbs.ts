import { Modules } from "@medusajs/framework/utils"
import { buildCategoryBreadcrumbsWorkflow } from "../workflows/build-category-breadcrumbs-workflow"

type BreadcrumbItem = {
    id: string
    name: string
    handle: string
}

/**
 * Backfill Breadcrumbs Script (Simplified)
 * 
 * Only processes products WITH existing primary_category_id
 * to generate/regenerate breadcrumbs.
 * 
 * Usage: yarn medusa exec ./src/scripts/backfill-breadcrumbs.ts
 */
export default async function backfillBreadcrumbs({ container }) {
    const query = container.resolve("query")
    const logger = container.resolve("logger")

    logger.info("[Backfill] Starting breadcrumbs backfill...")

    try {
        // Fetch ALL products using query.graph
        const { data: products } = await query.graph({
            entity: "product",
            fields: ["id", "title", "metadata"],
        })

        logger.info(`[Backfill] Found ${products.length} total products`)

        // Filter products that have primary_category_id but no breadcrumbs
        const productsNeedingBreadcrumbs = products.filter(
            (p: any) =>
                p.metadata?.primary_category_id &&
                !p.metadata?.main_category_breadcrumbs
        )

        logger.info(`[Backfill] ${productsNeedingBreadcrumbs.length} products need breadcrumbs`)

        let successCount = 0
        let errorCount = 0

        for (const product of productsNeedingBreadcrumbs) {
            try {
                const categoryId = product.metadata.primary_category_id as string

                // Generate breadcrumbs using workflow
                const { result } = await buildCategoryBreadcrumbsWorkflow(container).run({
                    input: { categoryId }
                })

                const breadcrumbs = result as BreadcrumbItem[]

                // Update product metadata using query
                await query.graph({
                    entity: "product",
                    fields: ["id"],
                    filters: { id: product.id },
                    options: {
                        update: {
                            metadata: {
                                ...product.metadata,
                                main_category_breadcrumbs: breadcrumbs
                            }
                        }
                    }
                })

                successCount++
                logger.info(`✅ [${successCount}/${productsNeedingBreadcrumbs.length}] ${product.title} (${breadcrumbs.length} levels)`)
            } catch (error: any) {
                errorCount++
                logger.error(`❌ Failed for ${product.title}:`, error.message)
            }
        }

        logger.info(`\n[Backfill] Complete!`)
        logger.info(`  Success: ${successCount} products`)
        logger.info(`  Errors: ${errorCount}`)
        logger.info(`  Skipped: ${products.length - productsNeedingBreadcrumbs.length} (no primary_category_id or already has breadcrumbs)`)
    } catch (error: any) {
        logger.error("[Backfill] Fatal error:", error.message)
        throw error
    }
}
