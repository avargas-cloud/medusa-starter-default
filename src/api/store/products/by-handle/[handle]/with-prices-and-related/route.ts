import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * GET /store/products/by-handle/:handle/with-prices-and-related
 * 
 * Consolidated endpoint that returns:
 * - Product details with customer-specific pricing
 * - Related products from the same category
 * - Category breadcrumbs
 * 
 * ✨ NEW: Uses Medusa Pricing Module for customer-specific pricing
 * - Retail customers see retail prices
 * - Wholesale customers see wholesale prices (via price lists)
 * - Anonymous users see default prices
 * 
 * @route GET /store/products/by-handle/:handle/with-prices-and-related
 */
export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const { handle } = req.params

        // Resolve services
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
                    console.log(`[WITH-PRICES-RELATED] 👤 Customer groups:`, pricingContext.customer_group_id)
                }
            } catch (error) {
                console.warn(`[WITH-PRICES-RELATED] ⚠️  Could not fetch customer groups`)
            }
        }

        // 1. Fetch main product
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
            filters: { handle }
        })

        console.log('[BREADCRUMB-DEBUG] Products count:', products.length)
        if (products.length > 0) {
            console.log('[BREADCRUMB-DEBUG] Product metadata keys:', Object.keys(products[0].metadata || {}))
            console.log('[BREADCRUMB-DEBUG] Full metadata object:', JSON.stringify(products[0].metadata, null, 2))
        }

        if (!products || products.length === 0) {
            return res.status(404).json({ message: "Product not found" })
        }

        const mainProduct = products[0]

        // Get breadcrumbs from database directly to avoid truncation by query.graph()
        // query.graph() sometimes truncates deep nested arrays in metadata
        const knex = req.scope.resolve("__pg_connection__")

        const productWithMetadata = await knex("product")
            .select("metadata")
            .where("id", mainProduct.id)
            .first()

        const breadcrumbs = productWithMetadata?.metadata?.main_category_breadcrumbs || null

        console.log('[BREADCRUMB-FIX] Breadcrumbs from DB:', breadcrumbs?.length || 0)
        if (breadcrumbs) {
            console.log('[BREADCRUMB-FIX] Breadcrumb names:', breadcrumbs.map((b: any) => b.name).join(' > '))
        }

        // Get attributes - handle gracefully if table doesn't exist (local dev)
        let attributes = []
        try {
            const attributeResults = await knex("product_to_attribute")
                .select("attribute_key", "attribute_value")
                .where("product_id", mainProduct.id)
                .whereNull("deleted_at")
                .orderBy("attribute_key")

            attributes = attributeResults || []
        } catch (error: any) {
            // Table might not exist in local dev environment
            if (error.message?.includes('does not exist')) {
                // Silently handle missing table in local dev
            } else {
                throw error // Re-throw if it's a different error
            }
        }

        // 2. Calculate prices for main product using Pricing Module
        const mainVariants = mainProduct.variants || []
        const mainPriceSetIds = mainVariants.map(v => v.price_set?.id).filter(Boolean)

        let mainCalculatedPrices = []
        if (mainPriceSetIds.length > 0) {
            mainCalculatedPrices = await pricingModule.calculatePrices(
                { id: mainPriceSetIds },
                { context: pricingContext }
            )
        }

        // Create variants with calculated prices for main product
        const mainVariantsWithPrices = mainVariants.map((variant: any) => {
            const priceData = mainCalculatedPrices.find(p => p.id === variant.price_set?.id)

            return {
                ...variant,
                calculated_price: priceData ? {
                    calculated_amount: priceData.calculated_amount,
                    original_amount: priceData.original_amount,
                    currency_code: priceData.currency_code
                } : null
            }
        })

        // 3. Fetch related products from same category
        const mainCategoryId = mainProduct.categories?.[0]?.id
        let relatedProducts = []

        if (mainCategoryId) {
            const { data: relatedProductsData } = await query.graph({
                entity: "product",
                fields: [
                    "id",
                    "title",
                    "handle",
                    "thumbnail",
                    "variants.*",
                    "variants.price_set.id"
                ],
                filters: {
                    categories: { id: mainCategoryId },
                    id: { $ne: mainProduct.id } // Exclude main product
                }
            })

            // Get up to 4 related products
            const limitedRelated = (relatedProductsData || []).slice(0, 4)

            // Calculate prices for related products
            if (limitedRelated.length > 0) {
                const relatedPriceSetIds = limitedRelated
                    .flatMap(p => p.variants || [])
                    .map(v => v.price_set?.id)
                    .filter(Boolean)

                let relatedCalculatedPrices = []
                if (relatedPriceSetIds.length > 0) {
                    relatedCalculatedPrices = await pricingModule.calculatePrices(
                        { id: relatedPriceSetIds },
                        { context: pricingContext }
                    )
                }

                // Map prices to related products
                relatedProducts = limitedRelated.map((product: any) => {
                    const variantsWithPrices = (product.variants || []).map((variant: any) => {
                        const priceData = relatedCalculatedPrices.find(p => p.id === variant.price_set?.id)

                        return {
                            ...variant,
                            calculated_price: priceData ? {
                                calculated_amount: priceData.calculated_amount,
                                original_amount: priceData.original_amount,
                                currency_code: priceData.currency_code
                            } : null
                        }
                    })

                    return {
                        ...product,
                        variants: variantsWithPrices
                    }
                })
            }
        }

        // 4. Return consolidated response
        return res.json({
            product: {
                ...mainProduct,
                variants: mainVariantsWithPrices,
                attributes: attributes || [],
                breadcrumbs
            },
            related_products: relatedProducts,
            customer_context: {
                customer_id: customerId || 'anonymous',
                customer_groups: pricingContext.customer_group_id || []
            }
        })

    } catch (error: any) {
        console.error("[WITH-PRICES-RELATED] Error:", error.message)
        return res.status(500).json({
            error: "Failed to fetch product",
            message: error.message
        })
    }
}
