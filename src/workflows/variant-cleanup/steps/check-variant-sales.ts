import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Step to check if variants have existing sales/orders
 * 
 * Returns: List of variants that CAN be deleted (no sales)
 *          and list that CANNOT be deleted (have sales)
 */
export const checkVariantSalesStep = createStep(
    "check-variant-sales",
    async (input: { variantIds: string[] }, { container }) => {
        const query = container.resolve(ContainerRegistrationKeys.QUERY)

        console.log(`🔍 Checking ${input.variantIds.length} variants for existing orders...`)

        const safeToDelete: string[] = []
        const protectedVariants: Array<{ variantId: string; orderCount: number }> = []

        // Check each variant for line items
        for (const variantId of input.variantIds) {
            const { data: lineItems } = await query.graph({
                entity: "order_line_item",
                fields: ["id", "order_id"],
                filters: {
                    variant_id: variantId
                }
            })

            if (lineItems && lineItems.length > 0) {
                protectedVariants.push({
                    variantId,
                    orderCount: lineItems.length
                })
                console.log(`   🛡️ Variant ${variantId}: PROTECTED (${lineItems.length} orders)`)
            } else {
                safeToDelete.push(variantId)
                console.log(`   ✅ Variant ${variantId}: Safe to delete`)
            }
        }

        return new StepResponse({
            safeToDelete,
            protectedVariants,
            totalChecked: input.variantIds.length
        })
    }
)
