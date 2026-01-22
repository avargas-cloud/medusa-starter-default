
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../../modules/product-attributes"
import ProductAttributesService from "../../../modules/product-attributes/service"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const service: ProductAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)

    // Fetch all sets
    const attribute_sets = await service.listAttributeSets({}, {
        relations: ["attributes"], // Include attributes to show count or details
        take: 999
    })

    // Wrap in object to match page.tsx expectation:
    // const sets: any[] = Array.isArray(setsData?.attribute_sets) ...
    res.json({ attribute_sets })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const service: ProductAttributesService = req.scope.resolve(PRODUCT_ATTRIBUTES_MODULE)
    const body = req.body as any

    // Auto-generate handle if missing
    if (body.title && !body.handle) {
        body.handle = body.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    }

    try {
        const set = await service.createAttributeSets(body)
        res.json({ attribute_set: set })
    } catch (error) {
        res.status(400).json({
            message: (error as Error).message,
        })
    }
}
