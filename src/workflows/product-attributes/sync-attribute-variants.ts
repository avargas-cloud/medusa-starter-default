import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { syncVariantsStep } from "./steps/sync-variants"

interface WorkflowInput {
    productId: string
    attributeKeyId: string
}

export const syncAttributeVariantsWorkflow = createWorkflow(
    "sync-attribute-variants",
    (input: WorkflowInput) => {
        syncVariantsStep(input)
        return new WorkflowResponse(input)
    }
)
