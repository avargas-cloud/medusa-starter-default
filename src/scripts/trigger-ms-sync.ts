import { MedusaContainer } from "@medusajs/types"
import { syncInventoryWorkflow } from "../workflows/sync-inventory"

export default async function run({ container }: { container: MedusaContainer }) {
    console.log("Triggering MeiliSearch inventory sync...")
    const { result } = await syncInventoryWorkflow(container).run({
        input: {}
    })
    console.log("Sync complete!", result)
}
