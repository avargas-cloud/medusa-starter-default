import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

// Workaround for Medusa's exported types missing the internal hooks:
const hooks = completeCartWorkflow.hooks as any

hooks.orderCreated(
    async ({ order_id }: { order_id: string }, { container }: { container: any }) => {
        const query = container.resolve("query")
        const orderModuleService = container.resolve(Modules.ORDER)

        console.log(`[Hooks] ⚡ Intercepting Order Creation for Order: ${order_id}`)

        // 1. Fetch the newly created order along with its line items
        // In V2, 'items' on the order are 'order_item', but the actual prices 
        // got saved to the underlying 'order_line_item' relation.
        const { data: orders } = await query.graph({
            entity: "order",
            fields: [
                "id",
                "items.*", // These are the order_item records (some with null unit_price)
                "items.item.*" // These are the order_line_item records (which HAVE the unit_price)
            ],
            filters: { id: order_id }
        })

        if (!orders.length) return new StepResponse(null)
        const order = orders[0]

        console.log(`[Hooks] 📦 Found ${order.items?.length || 0} items for order. Inspecting first item:`, JSON.stringify(order.items?.[0], null, 2))

        // 2. Prepare the updates to sync the unit_price from the line item back to the order item
        const itemsToUpdate = order.items
            .filter((orderItem: any) => orderItem.unit_price == null && orderItem.item?.unit_price != null)
            .map((orderItem: any) => ({
                id: orderItem.id,
                unit_price: orderItem.item.unit_price
            }))

        if (itemsToUpdate.length > 0) {
            console.log(`[Hooks] 🔧 Fixing ${itemsToUpdate.length} order items with null prices...`)

            // 3. Update the items natively
            await orderModuleService.updateOrderItems(itemsToUpdate)

            console.log(`[Hooks] ✅ Order items prices restored.`)
        }

        return new StepResponse(null)
    }
)
