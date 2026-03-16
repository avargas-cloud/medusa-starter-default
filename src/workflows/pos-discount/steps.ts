import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { IOrderModuleService } from "@medusajs/types"
import { Modules } from "@medusajs/utils"
// import { ChangeActionType } from "@medusajs/utils"

type OverrideAdjustmentsInput = {
    order_id: string
    promotion_code?: string
    pct_discount?: number | null // decimals e.g 0.05 for 5%
}

export const overrideOrderChangeAdjustmentsStep = createStep(
    "override-order-change-adjustments",
    async (input: OverrideAdjustmentsInput, { container }) => {
        const orderModule = container.resolve<IOrderModuleService>(Modules.ORDER)
        const logger = container.resolve("logger")

        try {
            // 1. Fetch the active OrderChange with its actions
            const orderChanges = await orderModule.listOrderChanges(
                {
                    order_id: input.order_id,
                    status: ["pending", "requested"],
                },
                {
                    relations: ["actions"],
                }
            )

            if (!orderChanges.length) {
                logger.warn(`[Override Step] No active order change found for order ${input.order_id}`)
                return new StepResponse(null)
            }

            const activeChange = orderChanges[0]
            const actions = activeChange?.actions || []

            // Find all ITEM_ADJUSTMENT actions
            const adjustmentActions = actions.filter((a: any) => 
                a.action === "ITEM_ADJUSTMENTS_REPLACE" || a.action === "ITEM_ADJUSTMENT_ADD"
            )

            if (!adjustmentActions.length) {
                logger.info(`[Override Step] No adjustment actions to override`)
                return new StepResponse(activeChange)
            }

            // 2. We need the latest items to compute exact frontend-perfect math
            const order = await orderModule.retrieveOrder(input.order_id, {
                relations: ["items"]
            })

            const actionsToUpdate = []

            for (const action of adjustmentActions) {
                // Medusa stashes the adjustments inside `details.adjustments`
                const details = action.details as any
                if (!details || !Array.isArray(details.adjustments)) continue

                let modified = false
                const newAdjustments = []

                for (const adj of details.adjustments) {
                    // Try to match the exact promo code
                    if (input.promotion_code && adj.code !== input.promotion_code) {
                        newAdjustments.push(adj)
                        continue
                    }

                    // Find the linked item
                    // the target item id might be on the adjustment or inferred
                    const itemId = adj.item_id || details.item_id || action.reference_id

                    const item = order.items?.find((i: any) => i.id === itemId)
                    if (!item) {
                        newAdjustments.push(adj)
                        continue
                    }

                    // 3. Mathematical Recalculation (Frontend exact match)
                    if (input.pct_discount != null && input.pct_discount > 0) {
                        const unitPrice = Number(item.unit_price) || 0
                        const qty = Number(item.quantity) || 1
                        
                        // Back to native non-rounded calculation as the user requested POS to adapt to Medusa
                        const correctAmount = unitPrice * qty * input.pct_discount
                        
                        logger.info(`[Override Step] Overwriting action ${action.id} amt: ${adj.amount} -> ${correctAmount}`)
                        
                        newAdjustments.push({
                            ...adj,
                            amount: correctAmount,
                            raw_amount: undefined // Let Medusa re-wrap it based on amount
                        })
                        modified = true
                    } else {
                        newAdjustments.push(adj)
                    }
                }

                if (modified) {
                    actionsToUpdate.push({
                        id: action.id,
                        details: {
                            ...details,
                            adjustments: newAdjustments
                        }
                    })
                }
            }

            // 4. Send the new JSON payloads back to the actions table
            if (actionsToUpdate.length > 0) {
                logger.info(`[Override Step] Patching ${actionsToUpdate.length} order_change_action payloads`)
                // updateOrderChangeActions allows passing ID and new payload
                await orderModule.updateOrderChangeActions(actionsToUpdate)
            }
            
            return new StepResponse(activeChange)
            
        } catch (e: any) {
            logger.error(`[Override Step Error] ${e.message}`)
            throw e
        }
    }
)
