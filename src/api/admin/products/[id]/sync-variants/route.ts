import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { syncAttributeVariantsWorkflow } from "../../../../../workflows/product-attributes/sync-attribute-variants"

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const { id } = req.params
    const { attribute_key_id } = req.body as { attribute_key_id: string }

    if (!attribute_key_id) {
        return res.status(400).json({ message: "attribute_key_id is required" })
    }

    const { result } = await syncAttributeVariantsWorkflow(req.scope).run({
        input: {
            productId: id,
            attributeKeyId: attribute_key_id,
        },
    })

    res.json({
        message: "Sync initiated",
        result
    })
}
