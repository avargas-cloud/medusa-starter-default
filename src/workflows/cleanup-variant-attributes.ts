import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

interface IdentifyVariantsInput {
    productId: any
    attributeKeyId: any
}

// ==================== STEP 1: Validate Variant Deletion (Cross-Module) ====================
const validateVariantDeletionStep = createStep(
    "validate-variant-deletion",
    async ({ variantIds }: { variantIds: string[] }, { container }) => {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)

        // 🔍 REMOTE QUERY: Cross module boundary (Product → Order)
        const { data: lineItems } = await query.graph({
            entity: "order_line_item",
            fields: ["id", "variant_id"],
            filters: {
                variant_id: variantIds,
            },
        })

        if (lineItems.length > 0) {
            // ⚠️ THIS IS KEY: Throwing here stops workflow and triggers rollback
            const affectedVariants = [...new Set(lineItems.map(item => item.variant_id))]
            throw new Error(
                `Cannot delete variants with existing orders (IDs: ${affectedVariants.join(", ")}). ` +
                `Please archive them manually instead.`
            )
        }

        return new StepResponse({ validated: true, variantCount: variantIds.length })
    }
)

// NOTE: This step is currently not used in the workflow due to type complexity
