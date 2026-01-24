import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * Advanced Product Search API Route
 * 
 * Queries MeiliSearch for products using AND logic and SKU indexing
 * Protected route - Admin only
 * 
 * GET /admin/search/products?q=<query>
 */

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const query = req.query.q as string

    if (!query || query.trim().length === 0) {
        return res.json({
            hits: [],
            query: "",
            processingTimeMs: 0,
            estimatedTotalHits: 0
        })
    }

    try {
        // Dynamic import to handle ESM module in CommonJS context
        const { MeiliSearch } = await import("meilisearch")

        // Initialize MeiliSearch client
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Search in products index
        const index = client.index("products")

        const searchResults = await index.search(query, {
            limit: 50,
            attributesToRetrieve: [
                "id",
                "title",
                "handle",
                "thumbnail",
                "variant_sku",
                "description"
            ],
        })

        return res.json({
            hits: searchResults.hits,
            query: searchResults.query,
            processingTimeMs: searchResults.processingTimeMs,
            estimatedTotalHits: searchResults.estimatedTotalHits,
        })

    } catch (error: any) {
        console.error("[MeiliSearch Error]:", error.message)

        return res.status(500).json({
            error: "Search failed",
            message: error.message,
            hits: []
        })
    }
}

// Middleware to protect this route (admin only)
export const AUTHENTICATE = ["user"]
