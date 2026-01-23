
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
        // 1. Fetch current links using Query Graph (Direct Pivot Query)
        // Traversing product -> attribute_value is brittle if the link name isn't exact.
        // Querying the pivot table "product_attribute_value" is robust.
        const { data: links } = await query.graph({
            entity: "product_attribute_value",
            fields: ["attribute_value_id"],
            filters: { product_id: productId }
        })

        const currentIds = links.map((l: any) => l.attribute_value_id)

        console.log("🔍 [WORKFLOW DEBUG] Update Attributes:")
        console.log("   - Product ID:", productId)
        console.log("   - Existing Link Count:", links.length)
        console.log("   - Current IDs:", currentIds)
        console.log("   - Incoming Value IDs:", valueIds)

        // 2. Diff
        const toCreate = valueIds.filter(id => !currentIds.includes(id))
        const toDismiss = currentIds.filter(id => !valueIds.includes(id))

        console.log("   - To Create:", toCreate)
        console.log("   - To Dismiss:", toDismiss)


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

import { updateProductMetadataStep } from "./steps/update-product-metadata"

export const updateProductAttributesWorkflow = createWorkflow(
    "update-product-attributes",
    (input: { productId: string, valueIds: string[], variantKeys: string[] }) => {
        updateLinksStep(input)

        updateProductMetadataStep({
            productId: input.productId,
            variantKeys: input.variantKeys
        })

        return new WorkflowResponse(input)
    }
)
