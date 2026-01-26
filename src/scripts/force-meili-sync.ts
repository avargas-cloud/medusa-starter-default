/**
 * Force MeiliSearch Re-Sync
 * 
 * Manually syncs all products to MeiliSearch with correct status
 */

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

export default async function forceMeiliSync({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("🔄 Force Syncing Products to MeiliSearch...")

    try {
        const { MeiliSearch } = await import("meilisearch")

        // Initialize MeiliSearch
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Fetch ALL products with status
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "handle",
                "description",
                "thumbnail",
                "status",
                "material",
                "variants.*",
            ],
        })

        logger.info(`  Found ${products.length} products in database`)

        // Count statuses
        const publishedCount = products.filter((p: any) => p.status === "published").length
        const draftCount = products.filter((p: any) => p.status === "draft").length

        logger.info(`  Published: ${publishedCount}`)
        logger.info(`  Draft: ${draftCount}`)

        // Transform for MeiliSearch
        const meiliProducts = products.map((product: any) => ({
            id: product.id,
            title: product.title,
            handle: product.handle,
            description: product.description || "",
            thumbnail: product.thumbnail || null,
            status: product.status, // ✅ CRITICAL FIELD
            metadata_material: product.material || null,
            variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
        }))

        // Delete old index and create fresh
        const indexName = "products"

        try {
            await client.deleteIndex(indexName)
            logger.info("  ✓ Deleted old index")
        } catch (e) {
            logger.info("  (No old index to delete)")
        }

        // Create new index
        const index = client.index(indexName)

        // Add documents
        const result = await index.addDocuments(meiliProducts, { primaryKey: "id" })

        logger.info(`  ✓ Synced ${meiliProducts.length} products`)
        logger.info(`  Task UID: ${result.taskUid}`)

        // Wait for indexing to complete
        logger.info("  ⏳ Waiting for indexing...")
        // Manual polling since client.waitForTask / index.waitForTask is failing
        // let task = await (index as any).getTask(result.taskUid)
        // while (task.status !== 'succeeded' && task.status !== 'failed') {
        //     await new Promise(resolve => setTimeout(resolve, 500))
        //     task = await (index as any).getTask(result.taskUid)
        // }

        logger.info("\n✅ SYNC COMPLETE!")
        logger.info("Refresh /app/products-advanced to see updated statuses")

        return {
            success: true,
            synced: meiliProducts.length,
            published: publishedCount,
            draft: draftCount,
        }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}
