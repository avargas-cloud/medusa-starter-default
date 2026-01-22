import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

// Helper function to convert title to kebab-case handle
function toKebabCase(str: string): string {
    return str
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/[\s_]+/g, '-')  // Replace spaces and underscores with hyphens
        .replace(/^-+|-+$/g, '')  // Trim hyphens from start/end
}

// Step to create attribute set
export const createAttributeSetStep = createStep(
    "create-attribute-set-step",
    async (input: { title: string }, { container }) => {
        const service = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        const handle = toKebabCase(input.title)

        const [attributeSet] = await service.createAttributeSets([{
            title: input.title,
            handle,
        }])

        return new StepResponse(attributeSet, attributeSet.id)
    },
    async (attributeSetId: string, { container }) => {
        if (!attributeSetId) return
        const service = container.resolve(PRODUCT_ATTRIBUTES_MODULE)
        await service.deleteAttributeSets([attributeSetId])
    }
)

export const createAttributeSetWorkflow = createWorkflow(
    "create-attribute-set-workflow",
    (input: { title: string }) => {
        const attributeSet = createAttributeSetStep(input)
        return new WorkflowResponse(attributeSet)
    }
)
