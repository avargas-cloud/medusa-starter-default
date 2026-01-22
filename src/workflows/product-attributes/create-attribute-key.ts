import {
    createStep,
    createWorkflow,
    StepResponse,
    WorkflowResponse
} from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

export type CreateAttributeKeyInput = {
    handle: string
    label: string
    options?: string[]
}

const createAttributeKeyStep = createStep(
    "create-attribute-key-step",
    async (input: CreateAttributeKeyInput, { container }) => {
        const service = container.resolve(PRODUCT_ATTRIBUTES_MODULE)
        const attributeKey = await service.createAttributeKeys(input)
        return new StepResponse(attributeKey, attributeKey.id)
    }
)

export const createAttributeKeyWorkflow = createWorkflow(
    "create-attribute-key",
    (input: CreateAttributeKeyInput) => {
        const attributeKey = createAttributeKeyStep(input)
        return new WorkflowResponse(attributeKey)
    }
)
