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

        const product = products[0]!  // Safe: we checked length above

        return res.json({
            product,
            test: "location_test",
            has_images: !!product.images,
            image_count: product.images?.length || 0
        })

    } catch (error: any) {
        console.error("Error:", error)
        return res.status(500).json({ error: (error as Error).message })
    }
}
