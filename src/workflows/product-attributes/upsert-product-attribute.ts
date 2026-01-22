import {
    createStep,
    createWorkflow,
    StepResponse,
    WorkflowResponse,
    transform
} from "@medusajs/framework/workflows-sdk"
import { createRemoteLinkStep } from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

export type UpsertProductAttributeInput = {
    productId: string
    attributeKeyHandle: string
    value: string
}

const upsertAttributeValueStep = createStep(
    "upsert-attribute-value-step",
    async (input: UpsertProductAttributeInput, { container }) => {
        const service = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // 1. Find the Key Definition
        const [key] = await service.listAttributeKeys({ handle: input.attributeKeyHandle })
        if (!key) {
            throw new Error(`Attribute Key with handle "${input.attributeKeyHandle}" not found`)
        }

        // 2. Find Existing Value
        const [existingValue] = await service.listAttributeValues({
            value: input.value,
            attribute_key_id: key.id
        })

        if (existingValue) {
            return new StepResponse(existingValue, existingValue.id)
        }

        // 3. Create New Value if not found
        const newValue = await service.createAttributeValues({
            value: input.value,
            attribute_key_id: key.id
        })

        return new StepResponse(newValue, newValue.id)
    }
)

export const upsertProductAttributeWorkflow = createWorkflow(
    "upsert-product-attribute",
    (input: UpsertProductAttributeInput) => {
        const attributeValue = upsertAttributeValueStep(input)

        const linkData = transform({ attributeValue, productId: input.productId }, (data: { attributeValue: { id: string }, productId: string }) => [
            {
                [Modules.PRODUCT]: {
                    product_id: data.productId,
                },
                [PRODUCT_ATTRIBUTES_MODULE]: {
                    attribute_value_id: data.attributeValue.id,
                },
            },
        ])

        createRemoteLinkStep(linkData)

        return new WorkflowResponse(attributeValue)
    }
)
