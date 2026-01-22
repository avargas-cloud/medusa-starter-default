
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function debugLinkStructure({ container }: ExecArgs) {
    const remoteLink = container.resolve("remoteLink")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    console.log(`🔍 Inspecting Link Structure for ${productId}...`)

    const variations = [
        { name: "Var 1: product_id", filter: { [Modules.PRODUCT]: { product_id: productId } } },
        { name: "Var 2: id", filter: { [Modules.PRODUCT]: { id: productId } } },
        { name: "Var 3: No Filter", filter: {}, config: { take: 2 } }
    ]

    for (const v of variations) {
        try {
            console.log(`\n🧪 Testing ${v.name}...`)
            const links = await remoteLink.list(v.filter, v.config || { take: 99 })
            console.log(`   ✅ Success! Found: ${links.length}`)
            if (links.length > 0) console.log("   📄 DUMP:", JSON.stringify(links[0], null, 2))
        } catch (e) {
            console.log(`   ❌ Failed: ${(e as Error).message}`)
        }
    }
}
