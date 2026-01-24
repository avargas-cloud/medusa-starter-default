import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import { checkVariantSalesStep } from "./steps/check-variant-sales"
import { findVariantsByOptionStep } from "./steps/find-variants-by-option"
import { deleteVariantsStep } from "./steps/delete-variants"
import { deleteOptionStep } from "./steps/delete-option"

type SafeDeleteOptionInput = {
    optionId: string
}

/**
 * Workflow: Safe Option Deletion with Variant Cleanup
 * 
 * Flow:
 * 1. Find all variants using this option
 * 2. Check if any variants have existing orders
 * 3. If protected variants exist → throw error
 * 4. If all safe → delete variants first, then option
 */
export const safeDeleteOptionWorkflow = createWorkflow(
    "safe-delete-option-with-cleanup",
    (input: SafeDeleteOptionInput) => {
        // Step 1: Find all variants that use this option
        const variantsResult = findVariantsByOptionStep({ optionId: input.optionId })

        // Step 2: Safety check - query for existing orders
        const safetyResult = checkVariantSalesStep(variantsResult)

        // Step 3: Delete variants (only safe ones)
        deleteVariantsStep(
            transform({ safetyResult }, (data) => ({
                variantIds: data.safetyResult.safeToDelete
            }))
        )

        // Step 4: Delete the option itself
        deleteOptionStep({ optionId: input.optionId })

        // Return workflow result
        return new WorkflowResponse(
            transform({ safetyResult }, (data) => ({
                optionId: input.optionId,
                variantsDeleted: data.safetyResult.safeToDelete.length,
                protectedVariants: data.safetyResult.protectedVariants,
                success: true
            }))
        )
    }
)
