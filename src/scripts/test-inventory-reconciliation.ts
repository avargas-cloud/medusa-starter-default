import { ExecArgs } from "@medusajs/framework/types"
import { syncInventoryWorkflow } from "../workflows/sync-inventory"

export default async function ({ container }: ExecArgs) {
    console.log("🧪 MANUAL TEST: Running Inventory Reconciliation Now")
    console.log("=============================================================\n")

    const { result } = await syncInventoryWorkflow(container).run({
        input: {}
    })

    console.log("\n=============================================================")
    console.log(`✅ Manual inventory reconciliation test completed!`)
    console.log(`   Synced: ${result.synced} items`)
    console.log(`   With categories: ${result.itemsWithCategory}`)
}
