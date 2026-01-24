import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * POST /admin/search/products/sync
 * 
 * Synchronize all products to MeiliSearch index
 * Called automatically when Advanced Search page loads
 */
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const { MeiliSearch } = await import("meilisearch")
        const query = req.scope.resolve("query")

        // Initialize MeiliSearch client
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Fetch all products with variants
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
                "variants.options.*",
                "variants.options.option.*",
            ],
        })

        // Transform products for MeiliSearch
        const meiliProducts = products.map((product: any) => ({
            id: product.id,
            title: product.title,
            handle: product.handle,
            description: product.description || "",
            thumbnail: product.thumbnail || null,
            status: product.status,
            material: product.material || null,
            variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
        }))

        // Sync to MeiliSearch
        const index = client.index("products")
        const result = await index.addDocuments(meiliProducts, { primaryKey: "id" })

        // console.log(`✅ Synced ${meiliProducts.length} products to MeiliSearch`)

        return res.json({
            success: true,
            synced: meiliProducts.length,
            taskUid: result.taskUid,
        })

    } catch (error: any) {
        console.error("[MeiliSearch Sync Error]:", error.message)

        return res.status(500).json({
            success: false,
            error: "Sync failed",
            message: error.message,
        })
    }
}

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"]
