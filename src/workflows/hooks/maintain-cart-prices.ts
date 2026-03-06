import { completeCartWorkflow } from "@medusajs/medusa/core-flows"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/utils"
// Workaround for Medusa's exported types missing the internal hooks:
const hooks = completeCartWorkflow.hooks as any

hooks.orderCreated(
    async ({ order_id }: { order_id: string }, { container }: { container: any }) => {
        const query = container.resolve("query")
        const orderModuleService = container.resolve("order")

        console.log(`\n================================================`)
        console.log(`Evento 1: Hook 'orderCreated' (maintain-cart-prices.ts) INTERCEPTING Order`)
        console.log(`================================================`)
        console.log(`Order ID: ${order_id}`)

        // 1. Fetch the newly created order along with its line items
        const { data: orders } = await query.graph({
            entity: "order",
            fields: [
                "id",
                "total",
                "subtotal",
                "tax_total",
                "shipping_total",
                "items.*",
                "items.item.*"
            ],
            filters: { id: order_id }
        })

        if (!orders.length) return new StepResponse(null)
        const order = orders[0]

        console.log(`\nOrder Current Totals:`)
        console.log(`  Subtotal:       ${order.subtotal}`)
        console.log(`  Tax Total:      ${order.tax_total}`)
        console.log(`  Shipping Total: ${order.shipping_total}`)
        console.log(`  Total Final:    ${order.total}`)

        if (order.items && order.items.length > 0) {
            order.items.forEach((item: any, i: number) => {
                console.log(`\n--- [Item ${i + 1}] Estado Inicial del order_item ---`)
                console.log(`  Título:        ${item.title || item.item?.title}`)
                console.log(`  Variant ID:    ${item.variant_id || item.item?.variant_id}`)
                console.log(`  Quantity:      ${item.quantity}`)
                console.log(`  Raw Quantity:  `, JSON.stringify(item.raw_quantity))
                console.log(`  Unit Price     (order_item): ${item.unit_price}`)
                console.log(`  Raw Unit Price (order_item):`, JSON.stringify(item.raw_unit_price))
                console.log(`  Unit Price     (order_line_item): ${item.item?.unit_price}`)
                console.log(`------------------------------------\n`)
            })
        }

        // 2. Prepare the updates
        const itemsToUpdate = order.items
            .filter((orderItem: any) => orderItem.unit_price == null && orderItem.item?.unit_price != null)
            .map((orderItem: any) => ({
                id: orderItem.id,
                unit_price: orderItem.item.unit_price,
            }))

        if (itemsToUpdate.length > 0) {
            console.log(`\n================================================`)
            console.log(`Evento 2: Fix de precios en Hook (Ejecutando updateOrderItems)`)
            console.log(`================================================`)
            console.log(`Se detectaron ${itemsToUpdate.length} items con unit_price nulo.`)
            console.log(`Datos a enviar a updateOrderItems:`, JSON.stringify(itemsToUpdate, null, 2))

            // 3. Update the items natively
            await orderModuleService.updateOrderItems(itemsToUpdate)

            console.log(`================================================\n`)
        } else {
            console.log(`\n================================================`)
            console.log(`Evento 2: Evaluación Completada (Ningún fix requerido)`)
            console.log(`================================================`)
            console.log(`Todos los ítems nacieron con unit_price persistido. No se necesita alterar nada.\n`)
        }

        // Re-emit order.placed so subscribers receive it reliably.
        // Medusa's internal emitEventStep goes to Redis async and is not
        // consistently delivered in the dev environment.
        try {
            const eventBusService = container.resolve(Modules.EVENT_BUS) as any
            await eventBusService.emit({ eventName: "order.placed", data: { id: order_id } })
            console.log(`[maintain-cart-prices] 📡 Emitted order.placed for ${order_id}`)
        } catch (emitErr: any) {
            console.warn(`[maintain-cart-prices] ⚠️ Could not emit order.placed: ${emitErr.message}`)
        }

        return new StepResponse(null)
    }
)
