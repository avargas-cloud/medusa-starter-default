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

        // Fetch all products with variants and categories
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
                "categories.handle",
                "categories.parent_category.handle",
                "categories.parent_category.parent_category.handle", // Depth 3
                "variants.*",
                "variants.options.*",
                "variants.options.option.*",
            ],
        })

        // Transform products for MeiliSearch
        const meiliProducts = products.map((product: any) => {
            // Flatten all category handles (including parents)
            const allCategoryHandles = new Set<string>()

            product.categories?.forEach((c: any) => {
                if (c.handle) allCategoryHandles.add(c.handle)
                if (c.parent_category?.handle) allCategoryHandles.add(c.parent_category.handle)
                if (c.parent_category?.parent_category?.handle) allCategoryHandles.add(c.parent_category.parent_category.handle)
            })

            return {
                id: product.id,
                title: product.title,
                handle: product.handle,
                description: product.description || "",
                thumbnail: product.thumbnail || null,
                status: product.status,
                metadata_material: product.material || null,
                category_handles: Array.from(allCategoryHandles), // ✅ Hierarchy support
                variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
            }
        })

        // Sync to MeiliSearch
        const index = client.index("products")

        // CRITICAL: Update settings to allow filtering and sorting
        await index.updateSettings({
            filterableAttributes: [
                "category_handles",
                "status",
                "id",
                "variant_sku"
            ],
            sortableAttributes: [
                "title",
                "status",
                "id"
            ],
            searchableAttributes: [
                "title",
                "variant_sku",
                "handle",
                "description",
                "metadata_material"
            ]
        })

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
