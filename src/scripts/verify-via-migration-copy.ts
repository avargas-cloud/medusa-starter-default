
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
// Import the service to ensure module registration side-effects occur, matching migration script
import ProductAttributesService from "../modules/product-attributes/service"

export default async function verifyViaMigrationCopy({ container }: ExecArgs) {
    const remoteLink = container.resolve("remoteLink")
    const query = container.resolve("query")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    console.log(`🔍 VERIFICATION via Migration Context for ${productId}...`)

    // Strategy 1: RemoteLink List
    try {
        console.log("\n🧪 Strategy 1: remoteLink.list")
        const links = await remoteLink.list({
            [Modules.PRODUCT]: { product_id: productId }
        })
        console.log(`   - Links Found: ${links.length}`)
        if (links.length > 0) console.log("   - Sample:", JSON.stringify(links[0]))
    } catch (e) {
        console.log(`   ❌ Failed: ${(e as Error).message}`)
    }

    // Strategy 2: Query Graph (user suggestion 'attributes' or 'product_attributes')
    try {
        console.log("\n🧪 Strategy 2: query.graph (product_attributes)")
        const { data } = await query.graph({
            entity: "product",
            fields: ["id", "product_attributes.*"],
            filters: { id: productId }
        })
        console.log(`   - Data:`, JSON.stringify(data[0]?.product_attributes ?? "undefined"))
    } catch (e) {
        console.log(`   ❌ Failed: ${(e as Error).message}`)
    }

    // Strategy 3: Query Graph (standard 'attribute_value')
    try {
        console.log("\n🧪 Strategy 3: query.graph (attribute_value)")
        const { data } = await query.graph({
            entity: "product",
            fields: ["id", "attribute_value.*"],
            filters: { id: productId }
        })
        console.log(`   - Data:`, JSON.stringify(data[0]?.attribute_value ?? "undefined"))
    } catch (e) {
        console.log(`   ❌ Failed: ${(e as Error).message}`)
    }
}
