import { ExecArgs } from "@medusajs/framework/types"
import { syncProductsWorkflow } from "../../workflows/sync-products"

export default async function ({ container }: ExecArgs) {
    console.log("🔄 Force syncing ALL products to MeiliSearch (bypassing count check)...")
    const { result } = await syncProductsWorkflow(container).run({ input: {} })
    console.log(`✅ Done! Synced ${result.synced} products to MeiliSearch.`)
}
