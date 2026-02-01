// @ts-nocheck - Dynamic attributes injection not in Product type definition
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/products/:id/with-prices EXACT COPY TEST
 * This is an EXACT copy of /products/[id]/route.ts to test if location matters
 */
export const GET_TEST = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params
        const query = req.scope.resolve("query")
        const knex = req.scope.resolve("__pg_connection__")

        // Fetch single product
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "handle",
                "description",
                "thumbnail",
                "status",
                "created_at",
                "updated_at",
                "metadata",
                "variants.*",
                "images.*",
                "options.*"
            ],
            filters: { id }
        })

        if (!products || products.length === 0) {
            return res.status(404).json({
                message: "Product not found",
                product: null
            })
        }

        const product = products[0]

        console.log(`[PRODUCT-ATTRS] 📦 Fetching attributes for product: ${product.title}`)

        // Batch fetch attributes (same logic as list endpoint)
        const allLinks = await knex("product_product_productattributes_attribute_value")
            .select("product_id", "attribute_value_id")
            .where("product_id", id)
            .whereNull("deleted_at")

        if (allLinks.length === 0) {
            console.log(`[PRODUCT-ATTRS] ℹ️  No attributes found for this product`)
            product.attributes = []
            return res.json({ product })
        }

        // Get unique attribute value IDs
        const allAttributeValueIds = [...new Set(allLinks.map((l: any) => l.attribute_value_id))]

        // Fetch attribute values with keys
        const { data: allAttributeValues } = await query.graph({
            entity: "attribute_value",
            fields: [
                "id",
                "value",
                "attribute_key.id",
                "attribute_key.handle",
                "attribute_key.label"
            ],
            filters: { id: allAttributeValueIds }
        })

        console.log(`[PRODUCT-ATTRS] 🔗 Found ${allLinks.length} links, ${allAttributeValues.length} unique values`)

        // Build attributes array
        const attributes: any[] = []

        allLinks.forEach((link: any) => {
            const attributeValue = allAttributeValues.find((av: any) => av.id === link.attribute_value_id)

            if (attributeValue) {
                attributes.push({
                    handle: attributeValue.attribute_key?.handle,
                    label: attributeValue.attribute_key?.label,
                    value: attributeValue.value
                })
            }
        })

        // Inject attributes into product
        product.attributes = attributes

        console.log(`[PRODUCT-ATTRS] ✅ Returning product with ${attributes.length} attributes`)

        return res.json({ product })

    } catch (error: any) {
        console.error("[PRODUCT-ATTRS] ❌ Error:", error.message)
        return res.status(500).json({
            error: "Failed to fetch product with attributes",
            message: error.message
        })
    }
}
