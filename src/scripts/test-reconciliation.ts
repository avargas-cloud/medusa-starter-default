import { ExecArgs } from "@medusajs/framework/types"
import reconcileMeiliSearchHandler from "../jobs/reconcile-meilisearch"

/**
 * Manual test script to trigger MeiliSearch reconciliation immediately
 * This runs the same code as the scheduled job
 */
export default async function ({ container }: ExecArgs) {
    console.log("🧪 MANUAL TEST: Running MeiliSearch Reconciliation Now")
    console.log("=" + "=".repeat(60))
    console.log("")

    await reconcileMeiliSearchHandler(container)

    console.log("")
    console.log("=" + "=".repeat(60))
    console.log("✅ Manual reconciliation test completed!")
}
