import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { syncInventoryWorkflow } from "../workflows/sync-inventory"

export default async function inventorySyncSubscriber({
    event,
    container,
}: SubscriberArgs<any>) {
    console.log(`⚡ [Inventory Subscriber] Event triggered: ${event.name}`)

    try {
        const { result } = await syncInventoryWorkflow(container)
            .run({
                input: {}
            })

        console.log(`✅ [Inventory Subscriber] Synced items to MeiliSearch. Result:`, result)
    } catch (error) {
        console.error(`❌ [Inventory Subscriber] Failed to sync:`, error)
    }
}

export const config: SubscriberConfig = {
    event: [
        "inventory.inventory-level.created",
        "inventory.inventory-level.updated",
        "inventory.inventory-level.deleted",
        "inventory.reservation-item.created",
        "inventory.reservation-item.deleted",
    ],
}
