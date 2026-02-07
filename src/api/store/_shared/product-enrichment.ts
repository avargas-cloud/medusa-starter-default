import type { MedusaRequest } from "@medusajs/framework/http"

/**
 * Enriches products with attributes and prices
 * Shared function used by /store/products and /store/categories/:id/products-with-filters
 */
export async function enrichProducts(products: any[], req: MedusaRequest) {
    if (!products || products.length === 0) {
        return products
    }

    const knex = req.scope.resolve("__pg_connection__")

    // Get all product IDs
    const productIds = products.map(p => p.id)

    // Batch fetch attribute links
    const attributeLinks = await knex("product_product_productattributes_attribute_value")
        .select("*")
        .whereIn("product_id", productIds)

    if (attributeLinks.length > 0) {
        // Get unique attribute_value IDs
        const attributeValueIds = [...new Set(attributeLinks.map((l: any) => l.attribute_value_id))]

        // Fetch attribute values with their keys
        const attributeValues = await knex("attribute_value")
            .select(
                "attribute_value.id",
                "attribute_value.value",
                "attribute_key.handle",
                "attribute_key.label"
            )
            .leftJoin("attribute_key", "attribute_value.attribute_key_id", "attribute_key.id")
            .whereIn("attribute_value.id", attributeValueIds)

        // Create lookup map
        const valueMap = new Map()
        attributeValues.forEach((val: any) => {
            valueMap.set(val.id, val)
        })

        // Group attributes by product
        const attributesByProduct = new Map()
        attributeLinks.forEach((link: any) => {
            const attributeValue = valueMap.get(link.attribute_value_id)
            if (attributeValue) {
                if (!attributesByProduct.has(link.product_id)) {
                    attributesByProduct.set(link.product_id, [])
                }

                attributesByProduct.get(link.product_id)!.push({
                    handle: attributeValue.handle,
                    label: attributeValue.label,
                    value: attributeValue.value
                })
            }
        })

        // Inject attributes into products
        products.forEach((product: any) => {
            product.attributes = attributesByProduct.get(product.id) || []
        })
    }

    // Calculate price ranges from variants
    // OPTIMIZATION: Batch fetch all prices for all products in ONE query instead of N queries

    // Collect all variant IDs from all products
    const allVariantIds: string[] = []
    for (const product of products) {
        if (product.variants && product.variants.length > 0) {
            allVariantIds.push(...product.variants.map((v: any) => v.id))
        }
    }

    if (allVariantIds.length === 0) {
        return products
    }

    // Single batch query for ALL prices
    const allPrices = await knex("price")
        .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
        .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
        .whereIn("product_variant_price_set.variant_id", allVariantIds)
        .where("price.currency_code", "usd")
        .whereNull("price.deleted_at")

    // Group prices by variant_id for easy lookup
    const pricesByVariant = new Map<string, number>()
    allPrices.forEach((p: any) => {
        pricesByVariant.set(p.variant_id, p.amount)
    })

    // Now process each product using the pre-fetched prices
    for (const product of products) {
        if (!product.variants || product.variants.length === 0) {
            continue
        }

        // Inject calculated_price into each variant
        const productPrices: number[] = []

        product.variants.forEach((variant: any) => {
            const amount = pricesByVariant.get(variant.id)
            if (amount !== undefined) {
                productPrices.push(amount)
                Object.assign(variant, {
                    calculated_price: {
                        calculated_amount: amount,
                        currency_code: "usd"
                    }
                })
            }
        })

        if (productPrices.length === 0) {
            continue
        }

        // Get min and max prices for product-level price/price_range
        const minPrice = Math.min(...productPrices)
        const maxPrice = Math.max(...productPrices)

        // If all prices are the same, return single price
        if (minPrice === maxPrice) {
            Object.assign(product, {
                price: {
                    amount: minPrice,
                    currency_code: "usd"
                }
            })
        } else {
            // Return price range
            Object.assign(product, {
                price_range: {
                    min: {
                        amount: minPrice,
                        currency_code: "usd"
                    },
                    max: {
                        amount: maxPrice,
                        currency_code: "usd"
                    }
                }
            })
        }
    }

    return products
}
