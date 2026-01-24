import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

/**
 * Step to find all variants associated with a product option
 */
export const findVariantsByOptionStep = createStep(
    "find-variants-by-option",
    async (input: { optionId: string }, { container }) => {
        const productService = container.resolve(Modules.PRODUCT)

        console.log(`🔍 Finding variants for option: ${input.optionId}`)

        // Get all variants that have this option value
        const variants = await productService.listProductVariants({
            options: {
                option_id: input.optionId
            }
        })

        const variantIds = variants.map(v => v.id)

        console.log(`   Found ${variantIds.length} variants to check`)

        return new StepResponse({ variantIds })
    }
)
