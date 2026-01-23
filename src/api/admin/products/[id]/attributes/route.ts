
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { updateProductAttributesWorkflow } from "../../../../../workflows/product-attributes/update-product-attributes"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../../modules/product-attributes"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const query = req.scope.resolve("query")
    const { id } = req.params

    console.log(`🔥 [API DEBUG] GET /attributes for Product: ${id}`)

    try {
        // 1. Get Links using Query Graph (remoteLink.list was failing)
        // Entity name confirmed via debug script: "product_attribute_value"
        console.log("   👉 Step 1: query.graph(product_attribute_value)...")

        const { data: links } = await query.graph({
            entity: "product_attribute_value",
            fields: ["attribute_value_id"],
            filters: { product_id: id }
        })

        console.log(`   ✅ Step 1 Success. Found ${links.length} links.`)

        const ids = links.map((l: any) => l.attribute_value_id)

        if (ids.length === 0) {
            return res.json({ attributes: [] })
        }

        // 2. Fetch Values
        console.log(`   👉 Step 2: Hydrating ${ids.length} attribute values...`)
        const { data: attributes } = await query.graph({
            entity: "attribute_value",
            fields: [
                "id",
                "value",
                "attribute_key.id",
                "attribute_key.label",
                "attribute_key.handle",
            ],
            filters: {
                id: ids
            }
        })

        console.log(`   ✅ Step 2 Success. Hydrated ${attributes.length} attributes.`)
        res.json({ attributes })

    } catch (error) {
        console.error("💥 [API ERROR] Critical failure in GET /attributes:", error)
        res.status(500).json({
            message: "Failed to fetch product attributes",
            error: (error as Error).message,
            stack: (error as Error).stack
        })
    }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    // Expect snake_case from frontend: value_ids, variant_keys
    const { value_ids, variant_keys } = req.body as { value_ids: string[], variant_keys: string[] }
    const { id } = req.params

    try {
        const { result } = await updateProductAttributesWorkflow(req.scope).run({
            input: {
                productId: id,
                valueIds: value_ids || [], // changed from attributes/attributeValueIds to match workflow
                variantKeys: variant_keys || [],
            }
        })

        res.json({ result })
    } catch (error) {
        console.error("💥 [API ERROR] POST /attributes Failed:", error)
        res.status(500).json({
            message: "Failed to update product attributes",
            error: (error as Error).message,
            stack: (error as Error).stack,
            details: JSON.stringify(error, Object.getOwnPropertyNames(error))
        })
    }
}
