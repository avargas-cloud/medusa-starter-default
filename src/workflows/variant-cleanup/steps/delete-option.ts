import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

/**
 * Step to delete product option
 */
export const deleteOptionStep = createStep(
    "delete-option",
    async (input: { optionId: string }, { container }) => {
        const productService = container.resolve(Modules.PRODUCT)

        console.log(`🗑️ Deleting option: ${input.optionId}`)

        await productService.deleteProductOptions([input.optionId])

        console.log(`   ✅ Option deleted`)

        return new StepResponse({ optionId: input.optionId })
    }
)
