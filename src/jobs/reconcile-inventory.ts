import { MedusaContainer, ScheduledJobConfig } from "@medusajs/framework/types"
import { syncInventoryWorkflow } from "../workflows/sync-inventory"

/**
 * Scheduled Job: Inventory MeiliSearch Reconciliation
 * 
 * Runs every 5 minutes to ensure inventory in MeiliSearch is in sync
 * Complements the middleware for immediate sync
 */
export default async function reconcileInventoryHandler(container: MedusaContainer) {
    console.log("🔄 [RECONCILE-INVENTORY] Starting inventory reconciliation...")

    try {
        const { result } = await syncInventoryWorkflow(container).run({
            input: {}
        })

        if (result.success) {
            console.log(`✅ [RECONCILE-INVENTORY] Synced ${result.synced} inventory items`)
            console.log(`   Items with categories: ${result.itemsWithCategory}`)
        } else {
            console.error(`❌ [RECONCILE-INVENTORY] Sync failed`)
        }
    } catch (error: any) {
        console.error("❌ [RECONCILE-INVENTORY] Reconciliation failed:", error.message)
        console.error(error.stack)
    }
}

/**
 * Schedule: Every 5 minutes
 */
export const config: ScheduledJobConfig = {
    name: "inventory-meilisearch-reconciliation",
    schedule: "*/5 * * * *", // Every 5 minutes
}
