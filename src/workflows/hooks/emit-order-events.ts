/**
 * emit-order-events.ts
 *
 * Re-emits order lifecycle events directly via eventBusService so that
 * subscribers receive them reliably. Medusa's internal emitEventStep
 * sends events to Redis async inside a workflow, which is NOT consistently
 * delivered to subscribers in the dev environment.
 *
 * order.placed → handled in maintain-cart-prices.ts (shares orderCreated hook)
 * order.canceled → handled here via cancelOrderWorkflow.hooks.orderCanceled
 */

import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/utils"

// ── order.canceled ────────────────────────────────────────────────────────────
// NOTE: cancelOrderWorkflow.hooks.orderCanceled passes { order } (full object),
// NOT { order_id }. We extract the id from order.id.
const cancelHooks = cancelOrderWorkflow.hooks as any
cancelHooks.orderCanceled(
    async ({ order }: { order: any }, { container }: { container: any }) => {
        const order_id = order?.id
        if (!order_id) {
            console.warn(`[emit-order-events] ⚠️ orderCanceled hook received no order.id — payload: ${JSON.stringify(order)}`)
            return
        }
        try {
            const eventBusService = container.resolve(Modules.EVENT_BUS) as any
            await eventBusService.emit({ eventName: "order.canceled", data: { id: order_id } })
            console.log(`[emit-order-events] 📡 Emitted order.canceled for ${order_id}`)
        } catch (err: any) {
            console.warn(`[emit-order-events] ⚠️ Could not emit order.canceled: ${err.message}`)
        }
    }
)
