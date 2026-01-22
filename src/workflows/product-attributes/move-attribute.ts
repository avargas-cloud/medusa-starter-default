import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

interface MoveAttributeInput {
    id: string
    attribute_set_id: string | null
}

// Step to move attribute to a different set
export const moveAttributeStep = createStep(
    "move-attribute-step",
    async (input: MoveAttributeInput, { container }) => {
        const service = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Get current state for compensation
        const [currentAttribute] = await service.listAttributeKeys({ id: input.id })
        const previousSetId = currentAttribute?.attribute_set_id || null

        // Update the attribute
        const [updatedAttribute] = await service.updateAttributeKeys([{
            id: input.id,
            attribute_set_id: input.attribute_set_id,
        }])

        return new StepResponse(updatedAttribute, {
            id: input.id,
            previousSetId,
        })
    },
    async (compensateData, { container }) => {
        if (!compensateData) return
        const service = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Revert to previous set
        await service.updateAttributeKeys([{
            id: compensateData.id,
            attribute_set_id: compensateData.previousSetId,
        }])
    }
)

export const moveAttributeWorkflow = createWorkflow(
    "move-attribute-workflow",
    (input: MoveAttributeInput) => {
        const result = moveAttributeStep(input)
        return new WorkflowResponse(result)
    }
)
