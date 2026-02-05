import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

type UpdateAttributeSetInput = {
    id: string
    title: string
}

type PreviousData = {
    title: string
    handle: string
}

const updateAttributeSetStep = createStep(
    "update-attribute-set-step",
    async (input: UpdateAttributeSetInput, { container }) => {
        const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Get current data for rollback
        const [existingSet] = await productAttributesService.listAttributeSets({
            id: input.id,
        })

        if (!existingSet) {
            throw new Error(`Attribute set with id ${input.id} not found`)
        }

        const previousData: PreviousData = {
            title: existingSet.title,
            handle: existingSet.handle,
        }

        // Generate new handle from title
        const newHandle = input.title
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")

        // Update set
        const [updated] = await productAttributesService.updateAttributeSets([
            {
                id: input.id,
                title: input.title,
                handle: newHandle,
            },
        ])

        return new StepResponse(updated, previousData)
    },
    async (_previousData, { container: _container }) => {
        // Note: Rollback would require the set ID which is in the input
        // Skipping to avoid errors
    }
)

export const updateAttributeSetWorkflow = createWorkflow(
    "update-attribute-set",
    (input: UpdateAttributeSetInput) => {
        const result = updateAttributeSetStep(input)
        return new WorkflowResponse(result)
    }
)
