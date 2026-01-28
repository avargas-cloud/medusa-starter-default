import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    // Extract search parameters from the request body
    const { q, offset, limit, filter, sort } = req.body as any

    try {
        // Dynamic import to handle ESM/CJS compatibility
        const { MeiliSearch } = await import("meilisearch")

        // Use the SERVER-SIDE keys (Master Key) which we know works
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        const index = client.index("inventory")

        const results = await index.search(q || "", {
            offset: offset || 0,
            limit: limit || 20,
            filter: filter,
            sort: sort,
            attributesToHighlight: ["title", "sku"]
        })

        res.json(results)
    } catch (err: any) {
        console.error("[Search Proxy Error]", err)
        res.status(500).json({ message: err.message })
    }
}

// Middleware to protect this route
export const AUTHENTICATE = ["user"]
