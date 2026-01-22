import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { bulkMoveAttributesWorkflow } from "../../../../workflows/product-attributes/bulk-move-attributes"

// POST - Bulk move attributes
export async function POST(
    req: MedusaRequest<{ attribute_ids: string[], target_set_id: string | null }>,
    res: MedusaResponse
) {
    const { attribute_ids, target_set_id } = req.body as {
        attribute_ids: string[]
        target_set_id: string | null
    }

    if (!attribute_ids || !Array.isArray(attribute_ids) || attribute_ids.length === 0) {
        return res.status(400).json({
            message: "attribute_ids must be a non-empty array",
        })
    }

    try {
        const { result } = await bulkMoveAttributesWorkflow(req.scope).run({
            input: { attribute_ids, target_set_id },
        })

        res.json(result)
    } catch (error) {
        res.status(400).json({
            message: (error as Error).message,
        })
    }
}
