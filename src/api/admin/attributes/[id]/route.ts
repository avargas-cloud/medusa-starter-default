import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../modules/product-attributes"

import { updateAttributeKeyWorkflow } from "../../../../workflows/product-attributes/update-attribute-key"

// GET Individual attribute
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params

    if (!id) {
        res.status(400).json({ error: "id parameter is required" })
        return
    }

    const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)
    const query = req.scope.resolve("query")

    try {
        const [attribute] = await productAttributesService.listAttributeKeys({
            id,
        })

        if (!attribute) {
            res.status(404).json({ message: "Attribute not found" })
            return
        }

        // Count products using this attribute
        let productCount = 0
        try {
            const values = await productAttributesService.listAttributeValues({
                attribute_key_id: id
            })

            if (values && values.length > 0) {
                const valueIds = values.map((v: any) => v.id)

                // Query the pivot table to find all products using these values
                const { data: links } = await query.graph({
                    entity: "product_attribute_value",
                    fields: ["product_id"],
                    filters: { attribute_value_id: valueIds }
                })

                // Count unique products
                const uniqueProductIds = new Set(
                    links.map((link: any) => link.product_id).filter(Boolean)
                )
                productCount = uniqueProductIds.size
            }
        } catch (linkError) {
            // Don't fail the whole request if product counting fails
            console.error("Failed to count products for attribute:", linkError)
            productCount = 0
        }

        res.json({
            attribute,
            product_count: productCount
        })
    } catch (error) {
        console.error("Error fetching attribute:", error)
        res.status(500).json({
            message: "Internal server error",
            error: (error as Error).message
        })
    }
}

// POST - Update Attribute
export async function POST(
    req: MedusaRequest<{ label: string; options?: string[] }>,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params

    if (!id) {
        res.status(400).json({ error: "id parameter is required" })
        return
    }

    try {
        const { result } = await updateAttributeKeyWorkflow(req.scope).run({
            input: {
                id,
                ...req.body
            },
        })

        res.json({ attribute: result })
    } catch (error) {
        res.status(400).json({
            message: "Failed to update attribute",
            error: (error as Error).message,
        })
    }
}

// DELETE attribute
export async function DELETE(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params

    if (!id) {
        res.status(400).json({ error: "id parameter is required" })
        return
    }

    const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)
    const query = req.scope.resolve("query")
    const remoteLink = req.scope.resolve("remoteLink")

    try {
        // 1. Clean up category filter references via HTTP
        const basePath = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"

        // Fetch all categories
        const categoriesResponse = await fetch(`${basePath}/admin/product-categories?limit=1000`, {
            headers: {
                "Cookie": req.headers.cookie || "",
                "Authorization": req.headers.authorization || ""
            }
        })

        if (categoriesResponse.ok) {
            const { product_categories: allCategories } = await categoriesResponse.json()

            for (const category of allCategories) {
                const filterConfig = category.metadata?.filter_config
                if (!filterConfig?.active_filters) continue

                let needsUpdate = false
                let updatedFilters = filterConfig.active_filters

                // Handle both old (string[]) and new (object[]) format
                if (Array.isArray(updatedFilters)) {
                    if (typeof updatedFilters[0] === 'string') {
                        // Old format: ["id1", "id2"]
                        if (updatedFilters.includes(id)) {
                            updatedFilters = updatedFilters.filter((attrId: string) => attrId !== id)
                            needsUpdate = true
                        }
                    } else {
                        // New format: [{attribute_id: "id1", order: 0, type: "checkbox"}]
                        const filtered = updatedFilters.filter((f: any) => f.attribute_id !== id)
                        if (filtered.length !== updatedFilters.length) {
                            // Recompute orders to avoid gaps
                            updatedFilters = filtered.map((f: any, index: number) => ({
                                ...f,
                                order: index
                            }))
                            needsUpdate = true
                        }
                    }
                }

                if (needsUpdate) {
                    await fetch(`${basePath}/admin/product-categories/${category.id}`, {
                        method: "POST",
                        headers: {
                            "Cookie": req.headers.cookie || "",
                            "Authorization": req.headers.authorization || "",
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            metadata: {
                                ...category.metadata,
                                filter_config: {
                                    ...filterConfig,
                                    active_filters: updatedFilters
                                }
                            }
                        })
                    })
                }
            }
        }

        // 2. Get all attribute values for this attribute
        const values = await productAttributesService.listAttributeValues({
            attribute_key_id: id
        })

        if (values && values.length > 0) {
            const valueIds = values.map((v: any) => v.id)

            // 2. Get all product links for these attribute values
            const { data: links } = await query.graph({
                entity: "product_attribute_value",
                fields: ["product_id", "attribute_value_id"],
                filters: { attribute_value_id: valueIds }
            })

            // 3. Remove all product links - dismiss requires both sides of the relationship
            if (links.length > 0) {
                const dismissPromises = links.map((link: any) =>
                    remoteLink.dismiss({
                        [Modules.PRODUCT]: { product_id: link.product_id },
                        [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: link.attribute_value_id }
                    })
                )
                await Promise.all(dismissPromises)
            }

            // 4. Delete the AttributeValues themselves
            await productAttributesService.deleteAttributeValues(valueIds)
        }

        // 5. Delete the AttributeKey itself
        await productAttributesService.deleteAttributeKeys([id])

        res.json({
            id,
            object: "attribute_key",
            deleted: true,
        })
    } catch (error) {
        res.status(500).json({
            message: "Failed to delete attribute",
            error: (error as Error).message,
        })
    }
}
