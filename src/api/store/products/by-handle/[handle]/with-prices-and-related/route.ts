import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * GET /store/products/by-handle/:handle/with-prices-and-related
 * 
 * Consolidated endpoint that returns:
 * - Full product data with prices and attributes
 * - Related products (from same category, limit 5)
 * - Breadcrumbs (from category tree)
 * 
 * Replaces 3-4 separate API calls with a single optimized query.
 * 
 * Performance target: <30ms
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { handle } = req.params
        const query = req.scope.resolve("query")
        const knex = req.scope.resolve("__pg_connection__")

        console.log(`[CONSOLIDATED] 📦 Fetching product by handle: ${handle}`)

        // Step 1: Get product by handle with all data
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
                "options.id",
                "options.title",
                "options.values.*",
                "categories.id",
                "categories.name",
                "categories.handle",
                "categories.parent_category_id"
            ],
            filters: {
                handle,
                status: "published"
            }
        })

        if (!products || products.length === 0) {
            return res.status(404).json({
                message: "Product not found",
                product: null,
                related_products: [],
                breadcrumbs: []
            })
        }

        const product: any = products[0]
        if (!product) {
            return res.status(404).json({ message: "Product not found" })
        }

        console.log(`[CONSOLIDATED] ✅ Found product: ${product.title}`)

        // Step 2: Fetch product attributes
        const productLinks = await knex("product_product_productattributes_attribute_value")
            .select("product_id", "attribute_value_id")
            .where("product_id", product.id)
            .whereNull("deleted_at")

        if (productLinks.length > 0) {
            const attributeValueIds = productLinks.map((l: any) => l.attribute_value_id)

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

            product.attributes = productLinks.map((link: any) => {
                const av = attributeValues.find((av: any) => av.id === link.attribute_value_id)
                return av ? {
                    handle: av.attribute_key?.handle,
                    label: av.attribute_key?.label,
                    value: av.value
                } : null
            }).filter(Boolean)

            console.log(`[CONSOLIDATED] 🏷️  Added ${product.attributes.length} attributes`)
        } else {
            product.attributes = []
        }

        // Step 3: Add prices to variants
        if (product.variants && product.variants.length > 0) {
            const variantIds = product.variants.map((v: any) => v.id)

            const prices = await knex("price")
                .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
                .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
                .whereIn("product_variant_price_set.variant_id", variantIds)
                .where("price.currency_code", "usd")
                .whereNull("price.deleted_at")

            const priceMap = new Map<string, number>()
            prices.forEach((p: any) => {
                priceMap.set(p.variant_id, p.amount)
            })

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

            console.log(`[CONSOLIDATED] 💰 Added prices to ${product.variants.length} variants`)
        }

        // Step 4: Build breadcrumbs from categories
        const breadcrumbs: any[] = []

        if (product.categories && product.categories.length > 0) {
            // Use the first category for breadcrumbs
            const category = product.categories[0]
            if (!category) {
                console.warn('[CONSOLIDATED] No category found')
            } else {

                // Build category tree upwards
                const categoryChain: any[] = [category]
                let currentCategoryId = category.parent_category_id

                while (currentCategoryId) {
                    const { data: parentCategories } = await query.graph({
                        entity: "product_category",
                        fields: ["id", "name", "handle", "parent_category_id"],
                        filters: { id: currentCategoryId }
                    })

                    if (parentCategories && parentCategories.length > 0 && parentCategories[0]) {
                        categoryChain.unshift(parentCategories[0])
                        currentCategoryId = parentCategories[0].parent_category_id
                    } else {
                        break
                    }
                }

                // Convert to breadcrumb format (match frontend expectations: {id, name, handle})
                categoryChain.forEach((cat: any) => {
                    breadcrumbs.push({
                        id: cat.id,
                        name: cat.name,
                        handle: cat.handle
                    })
                })

                console.log(`[CONSOLIDATED] 🍞 Built ${breadcrumbs.length} breadcrumbs`)
            }
        }

        // Step 5: Get related products (same category, limit 5, exclude current)
        let relatedProducts: any[] = []

        if (product.categories && product.categories.length > 0 && product.categories[0]) {
            const categoryId = product.categories[0].id
            const categoryHandle = product.categories[0].handle

            console.log(`[CONSOLIDATED] 🔍 Fetching related products for category: ${categoryHandle} (${categoryId})`)

            try {
                const { data: related } = await query.graph({
                    entity: "product",
                    fields: [
                        "id",
                        "title",
                        "handle",
                        "thumbnail",
                        "variants.*"
                    ],
                    filters: {
                        categories: { handle: categoryHandle } as any,
                        status: "published"
                    },
                    pagination: {
                        take: 6, // Get 6 so we can exclude current and still have 5
                        skip: 0
                    }
                })

                // Manually exclude current product
                relatedProducts = (related || []).filter((p: any) => p.id !== product.id).slice(0, 5)

                console.log(`[CONSOLIDATED] 🔗 Found ${related?.length || 0} products in category, ${relatedProducts.length} after filtering`)
            } catch (error) {
                console.error(`[CONSOLIDATED] ❌ Error fetching related products:`, error)
            }

            // Add prices to related products
            if (relatedProducts.length > 0) {
                const allRelatedVariantIds = relatedProducts
                    .flatMap((p: any) => p.variants?.map((v: any) => v.id) || [])

                if (allRelatedVariantIds.length > 0) {
                    const relatedPrices = await knex("price")
                        .select("price.amount", "price.currency_code", "product_variant_price_set.variant_id")
                        .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
                        .whereIn("product_variant_price_set.variant_id", allRelatedVariantIds)
                        .where("price.currency_code", "usd")
                        .whereNull("price.deleted_at")

                    const relatedPriceMap = new Map<string, number>()
                    relatedPrices.forEach((p: any) => {
                        relatedPriceMap.set(p.variant_id, p.amount)
                    })

                    relatedProducts.forEach((relatedProduct: any) => {
                        if (relatedProduct.variants) {
                            relatedProduct.variants.forEach((variant: any) => {
                                const amount = relatedPriceMap.get(variant.id)
                                if (amount !== undefined) {
                                    Object.assign(variant, {
                                        calculated_price: {
                                            calculated_amount: amount,
                                            currency_code: "usd"
                                        }
                                    })
                                }
                            })
                        }
                    })
                }
            }

            console.log(`[CONSOLIDATED] 🔗 Found ${relatedProducts.length} related products`)
        }

        console.log(`[CONSOLIDATED] ✅ Returning consolidated response`)

        return res.json({
            product,
            related_products: relatedProducts,
            breadcrumbs
        })

    } catch (error: any) {
        console.error("[CONSOLIDATED] ❌ Error:", (error as Error).message)
        return res.status(500).json({
            error: "Failed to fetch product data",
            message: (error as Error).message
        })
    }
}
