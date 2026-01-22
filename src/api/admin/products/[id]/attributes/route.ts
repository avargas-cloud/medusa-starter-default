
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { updateProductAttributesWorkflow } from "../../../../../workflows/product-attributes/update-product-attributes"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../../modules/product-attributes"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")
    const remoteLink = req.scope.resolve("remoteLink")
    const { id } = req.params

    try {
        // 1. Get Links directly (Since Graph traversal is defaulting to 1:1)
        // This is the robust fix to ensure we get ALL links
        const links = await remoteLink.list({
            [Modules.PRODUCT]: { product_id: id }
        })

        const ids = links.map((l: any) => l.attribute_value_id)

        if (ids.length === 0) {
            console.log(`🔍 [API] No links found for ${id}`)
            return res.json({ attributes: [] })
        }

        // 2. Fetch Values
        const { data: attributes } = await query.graph({
            entity: "attribute_value",
            fields: [
                "id",
                "value",
                "metadata",
                "attribute_key.id",
                "attribute_key.label",
                "attribute_key.handle",
                "attribute_key.attribute_set.id",
                "attribute_key.attribute_set.title"
            ],
            filters: {
                id: ids
            }
        })

        console.log(`🔍 [API] Hydrated ${attributes.length} attributes for ${id}`)

        res.json({ attributes })
    } catch (error) {
        console.error("❌ [API] Error fetching attributes:", error)
        res.status(500).json({
            message: "Failed to fetch product attributes",
            error: (error as Error).message
        })
    }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { attributes, variant_keys } = req.body
    const { id } = req.params

    try {
        const { result } = await updateProductAttributesWorkflow(req.scope).run({
            input: {
                productId: id,
                attributeValueIds: attributes,
            }
        })

        // TODO: Handle variant_keys if passed in (future step)

        res.json({ result })
    } catch (error) {
        res.status(500).json({
            message: "Failed to update product attributes",
            error: (error as Error).message
        })
    }
}
