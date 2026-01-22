import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { moveAttributeWorkflow } from "../../../../../workflows/product-attributes/move-attribute"

// POST - Move attribute to a different set
export async function POST(
    req: MedusaRequest<{ attribute_set_id?: string | null }>,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params
    const { attribute_set_id } = req.body as { attribute_set_id?: string | null }

    try {
        const { result } = await moveAttributeWorkflow(req.scope).run({
            input: {
                id,
                attribute_set_id: attribute_set_id || null,
            },
        })

        res.json({ attribute: result })
    } catch (error) {
        res.status(500).json({
            message: "Failed to move attribute",
            error: (error as Error).message,
        })
    }
}
