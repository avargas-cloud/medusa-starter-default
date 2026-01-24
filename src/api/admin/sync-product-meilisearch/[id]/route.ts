import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * POST /admin/sync-product-meilisearch/:id
 * 
 * Manual endpoint to sync a single product to MeiliSearch
 * Call this after any product/variant update
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const productId = req.params.id
    const logger = req.scope.resolve("logger")
    const query = req.scope.resolve("query")

    try {
        logger.info(`[MeiliSearch Sync API] Syncing product: ${productId}`)

        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "description",
                "handle",
                "thumbnail",
                "status",
                "metadata",
                "variants.id",
                "variants.sku",
            ],
            filters: { id: productId },
        })

        if (!products || products.length === 0) {
            res.status(404).json({ message: "Product not found" })
            return
        }

        const product = products[0]

        const { MeiliSearch } = await import("meilisearch")

        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
            apiKey: process.env.MEILISEARCH_API_KEY || "",
        })

        const index = client.index("products")

        const document = {
            id: product.id,
            title: product.title,
            description: product.description,
            handle: product.handle,
            thumbnail: product.thumbnail,
            variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
            metadata: product.metadata || {},
            metadata_material: product.metadata?.material || null,
            metadata_category: product.metadata?.category || null,
            status: product.status,
        }

        await index.addDocuments([document], { primaryKey: "id" })

        logger.info(
            `[MeiliSearch Sync API] ✅ Synced: ${product.title} | SKUs: [${document.variant_sku.join(", ")}]`
        )

        res.status(200).json({
            success: true,
            product: product.title,
            skus: document.variant_sku,
        })
    } catch (error: any) {
        logger.error(`[MeiliSearch Sync API] ❌ Error: ${error.message}`)
        res.status(500).json({ error: error.message })
    }
}
