
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function verifyLinksCorrectly({ container }: ExecArgs) {
    const remoteLink = container.resolve("remoteLink")
    const query = container.resolve("query")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    try {
        console.log(`🔍 FINAL VERIFICATION for ${productId}...`)

        // Step 1: List Links
        const links = await remoteLink.list({
            [Modules.PRODUCT]: { product_id: productId }
        })

        console.log(`Phase 1: Links Found in DB: ${links.length}`)

        if (links.length === 0) {
            console.log("❌ No links found. Migration failed for this product.")
            return
        }

        // Step 2: Fetch Values
        const ids = links.map((l: any) => l.attribute_value_id)
        const { data: attributes } = await query.graph({
            entity: "attribute_value",
            fields: ["id", "value", "attribute_key.label"],
            filters: { id: ids }
        })

        console.log(`Phase 2: Hydrated Attributes: ${attributes.length}`)

        // Sample Output
        if (attributes.length > 0) {
            console.log("✅ SUCCESS! Sample Attributes:")
            attributes.slice(0, 5).forEach((a: any) => {
                console.log(`   - ${a.attribute_key?.label}: ${a.value}`)
            })
            if (attributes.length > 5) console.log(`   ... and ${attributes.length - 5} more.`)
        }
    } catch (e) {
        console.error("❌ CRITICAL SCRIPT ERROR:", e)
    }
}
