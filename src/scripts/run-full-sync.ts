import { ExecArgs } from "@medusajs/framework/types"
import { syncProductsWorkflow } from "../workflows/sync-products"
import { syncInventoryWorkflow } from "../workflows/sync-inventory"

export default async function runFullSync({ container }: ExecArgs) {
    console.log("Triggering Full MeiliSearch Product Sync...")
    await syncProductsWorkflow(container).run()
    console.log("Product Sync Finished.")

    console.log("Triggering Full MeiliSearch Inventory Sync...")
    await syncInventoryWorkflow(container).run()
    console.log("Inventory Sync Finished.")
}
