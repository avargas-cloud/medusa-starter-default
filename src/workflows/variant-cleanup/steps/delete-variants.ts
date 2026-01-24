import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

/**
 * Step to delete product variants (only those safe to delete)
 */
export const deleteVariantsStep = createStep(
    "delete-variants",
    async (input: { variantIds: string[] }, { container }) => {
        if (input.variantIds.length === 0) {
            console.log("   ℹ️ No variants to delete")
            return new StepResponse({ deleted: 0 }, [])
        }

        const productService = container.resolve(Modules.PRODUCT)

        console.log(`🗑️ Deleting ${input.variantIds.length} variants...`)

        await productService.deleteProductVariants(input.variantIds)

        console.log(`   ✅ Deleted ${input.variantIds.length} variants`)

        return new StepResponse({
            deleted: input.variantIds.length
        }, input.variantIds)
    },
    async (deletedIds: string[] | undefined, { container }) => {
        // Compensation: restore deleted variants if workflow fails
        console.log(`   ⏪ Compensation: Would restore ${deletedIds?.length || 0} variants`)
    }
)
