import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../modules/product-attributes"

import { updateAttributeKeyWorkflow } from "../../../../workflows/product-attributes/update-attribute-key"

// GET Individual attribute
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params
    const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)

    try {
        const [attribute] = await productAttributesService.listAttributeKeys({
            id,
        })

        if (!attribute) {
            res.status(404).json({ message: "Attribute not found" })
            return
        }

        res.json({ attribute })
    } catch (error) {
        res.status(500).json({ message: "Internal server error" })
    }
}

// POST - Update Attribute
export async function POST(
    req: MedusaRequest<{ label: string; options?: string[] }>,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params


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
    const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)

    try {
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
