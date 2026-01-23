import { createAttributeKeyWorkflow } from "../../../workflows/product-attributes/create-attribute-key"

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../modules/product-attributes"
export async function GET(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const productAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)

    const attribute_keys = await productAttributesService.listAttributeKeys({}, {
        relations: ["values"]
    })

    console.log("DEBUG: GET /admin/attributes RESPONSE SAMPLE:", JSON.stringify(attribute_keys[0], null, 2))

    res.json({ attribute_keys })
}

export async function POST(
    req: MedusaRequest<{ label: string; handle: string; options?: string[] }>,
    res: MedusaResponse
): Promise<void> {
    const { label, handle, options } = req.body

    try {
        const { result } = await createAttributeKeyWorkflow(req.scope).run({
            input: {
                label,
                handle,
                options
            }
        })

        res.json({ attribute: result })
    } catch (error) {
        res.status(400).json({
            message: "Failed to create attribute",
            error: (error as Error).message
        })
    }
}
