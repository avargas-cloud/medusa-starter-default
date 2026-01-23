
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../../../modules/product-attributes"
import ProductAttributesModuleService from "../../../../../modules/product-attributes/service"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id } = req.params
    const { value } = req.body as { value: string }

    const service: ProductAttributesModuleService = req.scope.resolve(
        PRODUCT_ATTRIBUTES_MODULE
    )

    try {
        const result = await service.createAttributeValues({
            value: value,
            attribute_key: id, // Linking to the parent key
        })

        res.json({ attribute_value: result })
    } catch (error) {
        res.status(500).json({
            message: "Failed to create attribute value",
            error: (error as Error).message,
        })
    }
}
