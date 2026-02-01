import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/test-product-images/:id
 * LOCATION TEST: Same code as /with-prices but different path
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params
        const query = req.scope.resolve("query")

        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "thumbnail",
                "images.*",
                "variants.*",
                "options.*"
            ],
            filters: { id }
        })

        if (!products || products.length === 0) {
            return res.status(404).json({ error: "Product not found" })
        }

        return res.json({
            product: products[0],
            test: "location_test",
            has_images: !!products[0].images,
            image_count: products[0].images?.length || 0
        })

    } catch (error: any) {
        console.error("Error:", error)
        return res.status(500).json({ error: error.message })
    }
}
