import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../modules/product-attributes"
import ProductAttributesService from "../../../../modules/product-attributes/service"

// POST - Update/Rename attribute set
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const { id } = req.params
    const service: ProductAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)

    try {
        // Standard Medusa V2 update expects selector + data, or upsert method
        // But our service extends MedusaService, so we use updateAttributeSets
        const updated = await service.updateAttributeSets({
            id: id,
            ...req.body as any
        })

        res.json({ attribute_set: updated })
    } catch (error) {
        res.status(400).json({
            message: (error as Error).message,
        })
    }
}

// DELETE - Safe delete
export async function DELETE(
    req: MedusaRequest,
    res: MedusaResponse
) {
    const { id } = req.params
    const service: ProductAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)

    try {
        // MedusaService default delete
        await service.deleteAttributeSets(id)

        res.json({
            id,
            object: "attribute_set",
            deleted: true,
        })
    } catch (error) {
        res.status(400).json({
            message: (error as Error).message,
        })
    }
}
