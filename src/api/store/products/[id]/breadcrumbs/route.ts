import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/framework/types"
import { getProductMainCategoryBreadcrumbs, BreadcrumbItem } from "../../../../utils/breadcrumbs"

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const productModuleService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)

    const { id } = req.params

    if (!id) {
        return res.status(400).json({ error: "Product ID is required" })
    }

    try {
        // Fetch product with categories
        const product = await productModuleService.retrieveProduct(id, {
            relations: ["categories", "categories.parent_category"]
        })

        // Generate breadcrumbs for main category
        const breadcrumbs = await getProductMainCategoryBreadcrumbs(product, productModuleService)

        res.json({
            product,
            main_category_breadcrumbs: breadcrumbs
        })
    } catch (error) {
        console.error("Error fetching product breadcrumbs:", error)
        res.status(500).json({
            error: "Failed to fetch product breadcrumbs",
            message: error instanceof Error ? error.message : "Unknown error"
        })
    }
}
