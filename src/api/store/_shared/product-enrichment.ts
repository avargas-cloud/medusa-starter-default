import type { MedusaRequest } from "@medusajs/medusa"
import { Knex } from "knex"

/**
 * Enriches products with attributes and prices
 * Shared function used by /store/products and /store/categories/:id/products-with-filters
 */
export async function enrichProducts(products: any[], req: MedusaRequest) {
    if (!products || products.length === 0) {
        return products
    }

    const knex: Knex = (req.scope.resolve("__pg__") as any).raw

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
    for (const product of products) {
        if (!product.variants || product.variants.length === 0) {
            continue
        }

        // Get all variant IDs for this product
        const variantIds = product.variants.map((v: any) => v.id)

        // Fetch prices through price_set relationship  
        const prices = await knex("price")
            .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
            .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
            .whereIn("product_variant_price_set.variant_id", variantIds)
            .where("price.currency_code", "usd")
            .whereNull("price.deleted_at")

        if (prices.length === 0) {
            continue
        }

        // Create price map by variant_id
        const priceMap = new Map<string, number>()
        prices.forEach((p: any) => {
            priceMap.set(p.variant_id, p.amount)
        })

        // Inject calculated_price into each variant
        product.variants.forEach((variant: any) => {
            const amount = priceMap.get(variant.id)
            if (amount !== undefined) {
                Object.assign(variant, {
                    calculated_price: {
                        calculated_amount: amount,
                        currency_code: "usd"
                    }
                })
            }
        })

        // Get min and max prices for product-level price/price_range
        const amounts = prices.map((p: any) => p.amount)
        const minPrice = Math.min(...amounts)
        const maxPrice = Math.max(...amounts)

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
