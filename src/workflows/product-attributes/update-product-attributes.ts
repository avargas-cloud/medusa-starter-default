
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

// Step: Diff & Update Links
const updateLinksStep = createStep(
    "update-attribute-links",
    async ({ productId, valueIds }: { productId: string, valueIds: string[] }, { container }) => {
        const remoteLink = container.resolve("remoteLink")
        const query = container.resolve("query")

        // 1. Fetch current links using Query Graph
        const { data: currentProduct } = await query.graph({
            entity: "product",
            fields: ["attribute_value.id"],
            filters: { id: productId }
        })

        const currentIds = Array.isArray(currentProduct?.[0]?.attribute_value)
            ? currentProduct[0].attribute_value.map((a: any) => a.id)
            : []

        // 2. Diff
        const toCreate = valueIds.filter(id => !currentIds.includes(id))
        const toDismiss = currentIds.filter(id => !valueIds.includes(id))

        const promises: Promise<any>[] = []

        if (toDismiss.length > 0) {
            promises.push(remoteLink.dismiss({
                [Modules.PRODUCT]: { product_id: productId },
                [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: toDismiss }
            }))
        }

        if (toCreate.length > 0) {
            promises.push(remoteLink.create(toCreate.map(id => ({
                [Modules.PRODUCT]: { product_id: productId },
                [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: id }
            }))))
        }

        await Promise.all(promises)

        return new StepResponse(valueIds, { oldIds: currentIds })
    },
    async (input, { container }) => {
        // Rollback logic (omitted for brevity)
    }
)

export const updateProductAttributesWorkflow = createWorkflow(
    "update-product-attributes",
    (input: { productId: string, valueIds: string[] }) => {
        updateLinksStep(input)
        return new WorkflowResponse(input)
    }
)
