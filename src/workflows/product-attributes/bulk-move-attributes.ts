import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

type BulkMoveAttributesInput = {
    attribute_ids: string[]
    target_set_id: string | null
}

type PreviousAssignments = {
    attribute_id: string
    previous_set_id: string | null
}[]

const bulkMoveAttributesStep = createStep(
    "bulk-move-attributes-step",
    async (input: BulkMoveAttributesInput, { container }) => {
        const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Get current assignments for rollback
        const attributes = await productAttributesService.listAttributeKeys({
            id: input.attribute_ids,
        })

        const previousAssignments: PreviousAssignments = attributes.map((attr: any) => ({
            attribute_id: attr.id,
            previous_set_id: attr.attribute_set_id,
        }))

        // Update all attributes
        const updates = input.attribute_ids.map((id) => ({
            id,
            attribute_set_id: input.target_set_id,
        }))

        await productAttributesService.updateAttributeKeys(updates)

        return new StepResponse(
            { moved_count: input.attribute_ids.length },
            previousAssignments
        )
    },
    async (previousAssignments, { container }) => {
        if (!previousAssignments) return

        const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Restore previous assignments
        const restoreUpdates = previousAssignments.map((item) => ({
            id: item.attribute_id,
            attribute_set_id: item.previous_set_id,
        }))

        await productAttributesService.updateAttributeKeys(restoreUpdates)
    }
)

export const bulkMoveAttributesWorkflow = createWorkflow(
    "bulk-move-attributes",
    (input: BulkMoveAttributesInput) => {
        const result = bulkMoveAttributesStep(input)
        return new WorkflowResponse(result)
    }
)
