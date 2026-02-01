import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { id } = req.params
    const query = req.scope.resolve("query")
    const knex = req.scope.resolve("__pg_connection__") as any

    try {
        // Get product with variants
        const { data: products } = await query.graph({
            entity: "product",
            filters: { id },
            fields: [
                "id",
                "title",
                "handle",
                "description",
                "options.id",
                "options.title",
                "options.values",
                "variants.id",
                "variants.title",
                "variants.sku",
                "variants.options",
                "variants.options.value"
            ]
        })

        if (!products || products.length === 0) {
            return res.status(404).json({ error: "Product not found" })
        }

        const product = products[0]

        // Get prices directly from database
        const pricesQuery = await knex.raw(`
      SELECT 
        pv.id as variant_id,
        p.amount,
        p.currency_code
      FROM product_variant pv
      LEFT JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
      LEFT JOIN price p ON p.price_set_id = pvps.price_set_id
      WHERE pv.product_id = ?
    `, [id])

        // Map prices to variants
        const variantsWithPrices = product.variants.map((variant: any) => {
            const price = pricesQuery.rows.find((p: any) => p.variant_id === variant.id)

            return {
                id: variant.id,
                title: variant.title,
                sku: variant.sku,
                options: variant.options,
                calculated_price: price ? {
                    calculated_amount: price.amount,
                    original_amount: price.amount,
                    currency_code: price.currency_code
                } : null
            }
        })

        res.json({
            product: {
                id: product.id,
                title: product.title,
                handle: product.handle,
                description: product.description,
                options: product.options,
                variants: variantsWithPrices
            }
        })
    } catch (error: any) {
        console.error("Error fetching product with prices:", error)
        res.status(500).json({ error: error.message })
    }
}
