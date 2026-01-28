import { ExecArgs } from "@medusajs/framework/types"
import { syncProductsWorkflow } from "../workflows/sync-products"

export default async function forceSyncProducts({ container }: ExecArgs) {
    console.log("🚀 Forcing Product Sync Workflow...")
    const { result } = await syncProductsWorkflow(container).run()
    console.log(`✅ Synced ${result.synced} products. Task UID: ${result.taskUid}`)
}
