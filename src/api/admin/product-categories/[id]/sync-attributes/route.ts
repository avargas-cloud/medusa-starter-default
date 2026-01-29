import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id: categoryId } = req.params
    const query = req.scope.resolve("query")
    const productModule = req.scope.resolve("product")

    console.log(`🔧 [SYNC-ATTRS] Starting sync for category ${categoryId}`)

    try {
        // 1. Fetch ALL products with categories (M2M relationship)
        const allProducts = await productModule.listProducts({}, {
            relations: ["categories"],
            take: 10000
        })

        // 2. Filter client-side for this category
        const products = allProducts.filter(p =>
            p.categories?.some((cat: any) => cat.id === categoryId)
        )

        console.log(`🔧 [SYNC-ATTRS] Found ${products.length} products in category ${categoryId}`)

        // ⭐ ALWAYS update metadata, even if 0 products (sets [] to prevent showing all attrs)
        if (products.length === 0) {
            await updateCategoryMetadata(categoryId, [], req)
            console.log(`✅ [SYNC-ATTRS] Category ${categoryId} has no products - set available_attributes to []`)
            return res.json({ success: true, attributeCount: 0, productCount: 0 })
        }

        // 3. Extract attribute KEYS from Link table
        const productIds = products.map(p => p.id)
        const uniqueAttrKeys = new Set<string>()

        for (const productId of productIds) {
            try {
                // Query the Link table (product_attribute_value)
                const { data: links } = await query.graph({
                    entity: "product_attribute_value",
                    fields: ["attribute_value_id"],
                    filters: { product_id: productId }
                })

                if (links && links.length > 0) {
                    // Get the values to extract their keys
                    const valueIds = links.map((l: any) => l.attribute_value_id)

                    const { data: values } = await query.graph({
                        entity: "attribute_value",
                        fields: ["attribute_key.id"],
                        filters: { id: valueIds }
                    })

                    values.forEach((val: any) => {
                        if (val.attribute_key?.id) {
                            uniqueAttrKeys.add(val.attribute_key.id)
                        }
                    })
                }
            } catch (error: any) {
                console.error(`   ⚠️ Error fetching attributes for product ${productId}:`, error.message)
                // Continue even if one product fails
            }
        }

        const attributeKeysArray = Array.from(uniqueAttrKeys)
        console.log(`🔧 [SYNC-ATTRS] Extracted ${attributeKeysArray.length} unique attribute keys`)

        // 4. Update category metadata via HTTP (most reliable in Medusa v2)
        await updateCategoryMetadata(categoryId, attributeKeysArray, req)

        console.log(`✅ [SYNC-ATTRS] Updated category ${categoryId} with ${attributeKeysArray.length} attributes from ${products.length} products`)

        return res.json({
            success: true,
            productCount: products.length,
            attributeCount: attributeKeysArray.length
        })

    } catch (error: any) {
        console.error(`❌ [SYNC-ATTRS] Error:`, error.message)
        return res.status(500).json({
            error: "Failed to sync attributes",
            message: error.message
        })
    }
}

/**
 * Update category metadata via HTTP
 */
async function updateCategoryMetadata(
    categoryId: string,
    attributeKeys: string[],
    req: MedusaRequest
): Promise<void> {
    const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"

    // Fetch current category
    const categoryResponse = await fetch(`${basePath}/admin/product-categories/${categoryId}`, {
        headers: {
            "Cookie": req.headers.cookie || "",
            "Authorization": req.headers.authorization || ""
        }
    })

    if (!categoryResponse.ok) {
        throw new Error(`Failed to fetch category: ${categoryResponse.status}`)
    }

    const { product_category } = await categoryResponse.json()

    // Update with new available_attributes
    const updateResponse = await fetch(`${basePath}/admin/product-categories/${categoryId}`, {
        method: "POST",
        headers: {
            "Cookie": req.headers.cookie || "",
            "Authorization": req.headers.authorization || "",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            metadata: {
                ...product_category.metadata,
                available_attributes: attributeKeys
            }
        })
    })

    if (!updateResponse.ok) {
        throw new Error(`Failed to update category: ${updateResponse.status}`)
    }
}
