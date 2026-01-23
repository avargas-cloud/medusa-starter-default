
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function debugApiLogic({ container }: ExecArgs) {
    const query = container.resolve("query")
    const remoteLink = container.resolve("remoteLink")

    // ID from the user's screenshot
    const id = "prod_100w-dimmable-power-supply-for-12vdc-led-units"

    console.log("🔥 [SCRIPT DEBUG] Diagnostics...")
    console.log(`   Modules.PRODUCT: '${Modules.PRODUCT}'`)
    console.log(`   remoteLink service exists? ${!!remoteLink}`)

    try {
        // TEST 1: Generic remoteLink list
        console.log("\n🧪 Test 1: remoteLink.list({}) (Fetch any link)...")
        try {
            const anyLinks = await remoteLink.list({})
            console.log(`   ✅ Success. Found ${anyLinks.length} generic links.`)
            if (anyLinks.length > 0) console.log("   Sample:", JSON.stringify(anyLinks[0]))
        } catch (e: any) {
            console.log(`   ❌ Failed: ${e.message}`)
        }

        // TEST 2: Targeted remoteLink list
        console.log(`\n🧪 Test 2: remoteLink.list({ product: { product_id: '${id}' } })...`)
        try {
            const links = await remoteLink.list({
                [Modules.PRODUCT]: { product_id: id }
            })
            console.log(`   ✅ Success. Found ${links.length} links for target.`)
        } catch (e: any) {
            console.log(`   ❌ Failed: ${e.message}`)
            console.log("   stack:", e.stack)
        }

        // TEST 3: Query Graph on Link Entity
        // Medusa names links mostly as "{moduleA}_{moduleB}" or "product_attribute_value"
        const possibleLinkNames = ["product_attribute_value", "product_attribute_values", "link_product_attribute_value"]

        for (const name of possibleLinkNames) {
            console.log(`\n🧪 Test 3.${name}: query.graph({ entity: '${name}' })...`)
            try {
                const { data } = await query.graph({
                    entity: name,
                    fields: ["*"],
                    filters: { product_id: id }
                })
                console.log(`   ✅ Success? Data length: ${data.length}`)
                if (data.length > 0) {
                    console.log("   found it!", data[0])
                    // If this works, we use this in the API!
                    break;
                }
            } catch (e: any) {
                console.log(`   ❌ Entity not found or error: ${e.message}`)
            }
        }

    } catch (error: any) {
        console.error("💥 Critical script failure:", error.message)
    }
}
