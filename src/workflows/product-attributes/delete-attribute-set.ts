import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { PRODUCT_ATTRIBUTES_MODULE } from "../../modules/product-attributes"

type DeleteAttributeSetInput = {
    id: string
}

type AttributeAssignment = {
    attribute_id: string
    previous_set_id: string
}

type DeletedSetData = {
    id: string
    title: string
    handle: string
    metadata: any
    attribute_assignments: AttributeAssignment[]
}

const deleteAttributeSetStep = createStep(
    "delete-attribute-set-step",
    async (input: DeleteAttributeSetInput, { container }) => {
        const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Get the set to delete
        const [setToDelete] = await productAttributesService.listAttributeSets({
            id: input.id,
        })

        if (!setToDelete) {
            throw new Error(`Attribute set with id ${input.id} not found`)
        }

        // Get all attributes in this set
        const attributes = await productAttributesService.listAttributeKeys({
            attribute_set_id: input.id,
        })

        // Store for rollback
        const deletedSetData: DeletedSetData = {
            id: setToDelete.id,
            title: setToDelete.title,
            handle: setToDelete.handle,
            metadata: setToDelete.metadata,
            attribute_assignments: attributes.map((attr: any) => ({
                attribute_id: attr.id,
                previous_set_id: input.id,
            })),
        }

        // Move all attributes to null (virtual Unsorted)
        if (attributes.length > 0) {
            const updates = attributes.map((attr: any) => ({
                id: attr.id,
                attribute_set_id: null,
            }))
            await productAttributesService.updateAttributeKeys(updates)
        }

        // Delete the set
        await productAttributesService.deleteAttributeSets([input.id])

        return new StepResponse(
            { deleted: true, attributes_moved: attributes.length },
            deletedSetData
        )
    },
    async (deletedSetData, { container }) => {
        if (!deletedSetData) return

        const productAttributesService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)

        // Recreate the set
        const [recreated] = await productAttributesService.createAttributeSets([
            {
                id: deletedSetData.id,
                title: deletedSetData.title,
                handle: deletedSetData.handle,
                metadata: deletedSetData.metadata,
            },
        ])

        // Re-assign attributes
        if (deletedSetData.attribute_assignments.length > 0) {
            const restoreUpdates = deletedSetData.attribute_assignments.map((item) => ({
                id: item.attribute_id,
                attribute_set_id: deletedSetData.id,
            }))
            await productAttributesService.updateAttributeKeys(restoreUpdates)
        }
    }
)

export const deleteAttributeSetWorkflow = createWorkflow(
    "delete-attribute-set",
    (input: DeleteAttributeSetInput) => {
        const result = deleteAttributeSetStep(input)
        return new WorkflowResponse(result)
    }
)
