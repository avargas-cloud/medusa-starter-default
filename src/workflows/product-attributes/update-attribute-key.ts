import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

type UpdateAttributeKeyInput = {
    id: string
    label?: string
    options?: string[]
    display_name?: string | null
    description?: string | null
    filter_type?: string | null
    icon?: string | null
    unit?: string | null
    filter_order?: number | null
}

const updateAttributeKeyStep = createStep(
    "update-attribute-key-step",
    async (input: UpdateAttributeKeyInput, { container }) => {
        const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        const [existing] = await productAttributesService.listAttributeKeys({
            id: input.id,
        }, {
            relations: ["values"]
        })

        if (!existing) {
            throw new Error(`Attribute with id ${input.id} not found`)
        }

        const previousData = {
            label: existing.label,
            options: existing.options,
            display_name: existing.display_name,
            description: existing.description,
            filter_type: existing.filter_type,
            filter_order: existing.filter_order,
            icon: existing.icon,
            unit: existing.unit,
        }

        // Update the AttributeKey
        const updatePayload: any = {
            id: input.id,
        }

        if (input.label !== undefined) updatePayload.label = input.label
        if (input.options !== undefined) updatePayload.options = input.options
        if (input.display_name !== undefined) updatePayload.display_name = input.display_name
        if (input.description !== undefined) updatePayload.description = input.description
        if (input.filter_type !== undefined) updatePayload.filter_type = input.filter_type
        if (input.filter_order !== undefined) updatePayload.filter_order = input.filter_order
        if (input.icon !== undefined) updatePayload.icon = input.icon
        if (input.unit !== undefined) updatePayload.unit = input.unit

        const [updated] = await productAttributesService.updateAttributeKeys([updatePayload])

        // Sync options to AttributeValue entities
        if (input.options !== undefined) {
            const newOptions = input.options
            const existingValues = existing.values || []

            // Create a map of existing values
            const existingValuesMap = new Map(
                existingValues.map((v: any) => [v.value, v])
            )

            // Values to create
            const valuesToCreate = newOptions
                .filter(option => !existingValuesMap.has(option))
                .map(option => ({
                    value: option,
                    attribute_key_id: input.id
                }))

            // Values to delete
            const valuesToDelete = existingValues
                .filter((v: any) => !newOptions.includes(v.value))
                .map((v: any) => v.id)

            // Create new values
            if (valuesToCreate.length > 0) {
                await productAttributesService.createAttributeValues(valuesToCreate)
            }

            // Delete removed values
            if (valuesToDelete.length > 0) {
                await productAttributesService.deleteAttributeValues(valuesToDelete)
            }
        }

        return new StepResponse(updated, previousData)
    },
    async (previousData, { container }) => {
        // Rollback logic would require knowing ID, which we don't pass here easily without context
        // Skipping complex rollback for now for simplicity, but could be added
    }
)

export const updateAttributeKeyWorkflow = createWorkflow(
    "update-attribute-key",
    (input: UpdateAttributeKeyInput) => {
        const result = updateAttributeKeyStep(input)
        return new WorkflowResponse(result)
    }
)
