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
        // @ts-ignore - auth_context is added by middleware
        const customerId = (req as any).auth_context?.actor_id
        if (customerId) {
            try {
                const customer = await customerModule.retrieveCustomer(customerId, {
                    relations: ["groups"]
                })

                if (customer.groups?.length) {
                    pricingContext.customer_group_id = customer.groups.map((g: any) => g.id)
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
                "options.*",
                "options.values.*",
                "categories.*",
                "categories.parent_category_id"
            ],
            filters: { handle }
        })

        if (!products || products.length === 0) {
            return res.status(404).json({ message: "Product not found" })
        }

        const mainProduct: any = products[0]

        // Options are now fetched natively via query.graph

        // Get breadcrumbs from database directly to avoid truncation by query.graph()
        // query.graph() sometimes truncates deep nested arrays in metadata
        const knex = req.scope.resolve("__pg_connection__")

        const productWithMetadata = await knex("product")
            .select("metadata")
            .where("id", mainProduct.id)
            .first()

        const breadcrumbs = productWithMetadata?.metadata?.main_category_breadcrumbs || null

        if (breadcrumbs && breadcrumbs.length > 0) {
        }

        // Get attributes via Medusa module link table (same pattern as /store/products)
        let attributes: any[] = []
        try {
            // Step 1: Get attribute value IDs linked to this product
            const links = await knex("product_product_productattributes_attribute_value")
                .select("attribute_value_id")
                .where("product_id", mainProduct.id)
                .whereNull("deleted_at")

            if (links.length > 0) {
                const attributeValueIds = links.map((l: any) => l.attribute_value_id)

                // Step 2: Fetch attribute values with their keys via query.graph
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

                // Step 3: Transform to frontend format {handle, label, value}
                attributes = attributeValues.map((av: any) => ({
                    handle: av.attribute_key?.handle || av.id,
                    label: av.attribute_key?.label || av.attribute_key?.handle || av.id,
                    value: av.value
                }))
            }
        } catch (error: any) {
            // Silently handle if attribute tables don't exist in local dev
            console.warn("[WITH-PRICES-RELATED] Could not fetch attributes:", error.message)
        }

        // 2. Calculate prices for main product using Pricing Module
        const mainVariants = mainProduct.variants || []
        const mainPriceSetIds = mainVariants.map((v: any) => v.price_set?.id).filter(Boolean)

        let mainCalculatedPrices: any[] = []
        if (mainPriceSetIds.length > 0) {
            mainCalculatedPrices = await pricingModule.calculatePrices(
                { id: mainPriceSetIds },
                { context: pricingContext }
            )
        }

        // 2b. Fetch inventory quantities for each variant via SQL
        // Medusa v2 stores inventory in a separate module — not in product_variant directly
        const variantIds = mainVariants.map((v: any) => v.id).filter(Boolean)
        const inventoryByVariant: Record<string, number> = {}

        if (variantIds.length > 0) {
            try {
                const inventoryRows = await knex("product_variant_inventory_item as pvi")
                    .join("inventory_level as il", "il.inventory_item_id", "pvi.inventory_item_id")
                    .select("pvi.variant_id")
                    .sum("il.stocked_quantity as total_stocked")
                    .sum("il.reserved_quantity as total_reserved")
                    .whereIn("pvi.variant_id", variantIds)
                    .groupBy("pvi.variant_id")

                for (const row of inventoryRows) {
                    const stocked = parseInt(row.total_stocked) || 0
                    const reserved = parseInt(row.total_reserved) || 0
                    inventoryByVariant[row.variant_id] = Math.max(0, stocked - reserved)
                }
            } catch (err: any) {
                // Silently skip if inventory tables don't exist (local dev without inventory module)
                console.warn("[WITH-PRICES-RELATED] Could not fetch inventory:", err.message)
            }
        }

        // Create variants with calculated prices for main product
        const mainVariantsWithPrices = mainVariants.map((variant: any) => {
            const priceData = mainCalculatedPrices.find((p: any) => p.id === variant.price_set?.id)

            return {
                ...variant,
                inventory_quantity: inventoryByVariant[variant.id] ?? null,
                calculated_price: priceData ? {
                    calculated_amount: priceData.calculated_amount,
                    original_amount: priceData.original_amount,
                    currency_code: priceData.currency_code
                } : null
            }
        })


        // 3. Fetch related products from same category
        const mainCategoryId = mainProduct.categories?.[0]?.id
        let relatedProducts: any[] = []

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
                    categories: { id: mainCategoryId } as any,
                    id: { $ne: mainProduct.id } // Exclude main product
                }
            })

            // Get up to 4 related products
            const limitedRelated = (relatedProductsData || []).slice(0, 4)

            // Calculate prices for related products
            if (limitedRelated.length > 0) {
                const relatedPriceSetIds = limitedRelated
                    .flatMap(p => p.variants || [])
                    .map((v: any) => v.price_set?.id)
                    .filter(Boolean)

                let relatedCalculatedPrices: any[] = []
                if (relatedPriceSetIds.length > 0) {
                    relatedCalculatedPrices = await pricingModule.calculatePrices(
                        { id: relatedPriceSetIds },
                        { context: pricingContext }
                    )
                }

                // Map prices to related products
                relatedProducts = limitedRelated.map((product: any) => {
                    const variantsWithPrices = (product.variants || []).map((variant: any) => {
                        const priceData = relatedCalculatedPrices.find((p: any) => p.id === variant.price_set?.id)

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
