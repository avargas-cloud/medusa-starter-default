import { MedusaContainer } from "@medusajs/framework/types"
import { syncSearchWorkflow } from "../workflows/sync-search"

export default async function main(container: MedusaContainer) {
    console.log("🧪 Testing Sync Workflow Isolation...")
    // console.log("Container Keys:", Object.keys(container)) // Might use awilix internal
    try {
        // Log all registrations
        const cradle = (container as any).cradle
        if (cradle) {
            console.log("Cradle Keys:", Object.keys(cradle).filter(k => k.includes("query")))
        }
    } catch (e) { }

    // Workflow input
    const input = {
        id: "prod_100w-dimmable-power-supply-for-12vdc-led-units",
        type: "product" as const, // Cast to literal
        eventName: "test.manual_trigger"
    }

    try {
        const { result, errors } = await syncSearchWorkflow(container).run({
            input,
            throwOnError: false
        })

        if (errors.length) {
            console.error("❌ Workflow Failed:", JSON.stringify(errors, null, 2))
        } else {
            console.log("✅ Workflow Succeeded:", result)
        }
    } catch (e) {
        console.error("❌ Unexpected Error:", e)
    }
}
