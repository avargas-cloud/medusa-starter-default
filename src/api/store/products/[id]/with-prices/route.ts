import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/framework/types"
import { getProductMainCategoryBreadcrumbs } from "../../../../utils/breadcrumbs"

/**
 * GET /store/products/:id/with-prices
 * 
 * Complete product data endpoint:
 * - Images (thumbnail + images array)
 * - Calculated prices per variant
 * - Category breadcrumbs
 * - Product attributes
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params
        const query = req.scope.resolve("query")
        const knex = req.scope.resolve("__pg_connection__")
        const productModuleService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)

        // 1. Fetch product with explicit image fields + categories for breadcrumbs
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
                "images.id",
                "images.url",
                "images.metadata",
                "images.rank",
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

        const originalProduct = products[0]

        // 2. Get breadcrumbs from product metadata (pre-calculated)
        // Products have main_category_breadcrumbs already calculated in metadata
        const breadcrumbs = originalProduct.metadata?.main_category_breadcrumbs || null

        // 3. Get variant IDs for pricing query
        const variantIds = originalProduct.variants.map((v: any) => v.id)

        // 5. Fetch prices
        const prices = await knex("price")
            .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
            .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
            .whereIn("product_variant_price_set.variant_id", variantIds)
            .where("price.currency_code", "usd")
            .whereNull("price.deleted_at")

        // 6. Create price map
        const priceMap = new Map<string, number>()
        prices.forEach((p: any) => {
            priceMap.set(p.variant_id, p.amount)
        })

        // 7. Create variants with calculated prices
        const variantsWithPrices = originalProduct.variants.map((variant: any) => {
            const amount = priceMap.get(variant.id)

            return {
                ...variant,
                calculated_price: amount !== undefined ? {
                    calculated_amount: amount,
                    currency_code: "usd"
                } : null
            }
        })

        // 8. Fetch product attributes
        const attributeLinks = await knex("product_product_productattributes_attribute_value")
            .select("attribute_value_id")
            .where("product_id", id)
            .whereNull("deleted_at")

        let attributes: any[] = []

        if (attributeLinks.length > 0) {
            const attributeValueIds = attributeLinks.map((link: any) => link.attribute_value_id)

            const { data: attributeValues } = await query.graph({
                entity: "attribute_value",
                fields: [
                    "id",
                    "value",
                    "attribute_key.id",
                    "attribute_key.handle",
                    "attribute_key.label"
                ],
                filters: { id: attributeValueIds }
            })

            attributes = attributeValues.map((av: any) => ({
                handle: av.attribute_key?.handle,
                label: av.attribute_key?.label,
                value: av.value
            }))
        }

        // 9. ✅ Create complete product response with spread operator
        const productResponse = {
            ...originalProduct,
            variants: variantsWithPrices,
            attributes: attributes
        }

        return res.json({
            product: productResponse,
            breadcrumbs: breadcrumbs  // Add breadcrumbs to response
        })

    } catch (error: any) {
        console.error("[WITH-PRICES] Error:", error)
        return res.status(500).json({
            error: "Failed to fetch product with prices",
            message: error.message
        })
    }
}
