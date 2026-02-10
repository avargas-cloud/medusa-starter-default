import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * GET /store/products/:id/with-prices
 * 
 * Fetches a product with prices, attributes, and category breadcrumbs.
 * 
 * ✨ NEW: Uses Medusa Pricing Module for customer-specific pricing
 * - Retail customers see retail prices
 * - Wholesale customers see wholesale prices (via price lists)
 * - Anonymous users see default prices
 * 
 * @route GET /store/products/:id/with-prices
 */
export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const { id } = req.params

        // Resolve query service
        const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
        const pricingModule = req.scope.resolve("pricing")
        const customerModule = req.scope.resolve("customer")

        // Build pricing context for customer-specific pricing
        const pricingContext: Record<string, any> = {
            currency_code: "usd",
            region_id: "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1"
        }

        // Get customer and their groups
        const customerId = req.auth_context?.actor_id
        if (customerId) {
            try {
                const customer = await customerModule.retrieveCustomer(customerId, {
                    relations: ["groups"]
                })

                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map(g => g.id)
                    console.log(`[WITH-PRICES] 👤 Customer groups:`, pricingContext.customer_group_id)
                }
            } catch (error) {
                console.warn(`[WITH-PRICES] ⚠️  Could not fetch customer groups`)
            }
        }

        // 1. Fetch product with attributes and category data
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "description",
                "handle",
                "thumbnail",
                "metadata",
                "variants.*",
                "variants.price_set.id",
                "variants.options.*",
                "categories.*",
                "categories.parent_category_id"
            ],
            filters: { id }
        })

        if (!products || products.length === 0) {
            return res.status(404).json({ message: "Product not found" })
        }

        const originalProduct = products[0]

        // Get breadcrumbs from metadata (pre-synced via middleware)
        const breadcrumbs = originalProduct.metadata?.main_category_breadcrumbs || null

        // Get variants with price_set_id
        const variants = originalProduct.variants || []

        // ✨ Calculate prices using Pricing Module (supports customer groups!)
        const priceSetIds = variants.map(v => v.price_set?.id).filter(Boolean)

        let calculatedPrices = []
        if (priceSetIds.length > 0) {
            calculatedPrices = await pricingModule.calculatePrices(
                { id: priceSetIds },
                { context: pricingContext }
            )
            console.log(`[WITH-PRICES] 💵 Calculated ${calculatedPrices.length} prices (customer-aware)`)
        }

        // Create variants with calculated prices
        const variantsWithPrices = variants.map((variant: any) => {
            const priceData = calculatedPrices.find(p => p.id === variant.price_set?.id)

            return {
                ...variant,
                calculated_price: priceData ? {
                    calculated_amount: priceData.calculated_amount,
                    original_amount: priceData.original_amount,
                    currency_code: priceData.currency_code
                } : null
            }
        })

        // Fetch product attributes (if they exist)
        const knex = req.scope.resolve("__pg_connection__")

        const attributes = await knex("product_to_attribute")
            .select("attribute_key", "attribute_value")
            .where("product_id", id)
            .whereNull("deleted_at")
            .orderBy("attribute_key")

        // Return product with enriched data
        return res.json({
            product: {
                ...originalProduct,
                variants: variantsWithPrices,
                attributes: attributes || [],
                breadcrumbs,
                customer_context: {
                    customer_id: customerId || 'anonymous',
                    customer_groups: pricingContext.customer_group_id || []
                }
            }
        })

    } catch (error: any) {
        console.error("[WITH-PRICES] Error:", error.message)
        return res.status(500).json({
            error: "Failed to fetch product",
            message: error.message
        })
    }
}
