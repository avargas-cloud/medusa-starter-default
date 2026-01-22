
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function checkMetadataSample({ container }: ExecArgs) {
    const productModule = container.resolve(Modules.PRODUCT)

    console.log("🔍 Sampling 10 random products to verify metadata...")

    const products = await productModule.listProducts({}, {
        take: 10,
        select: ["id", "title", "metadata"]
    })

    let foundCount = 0
    let missingCount = 0

    products.forEach(p => {
        const wcAttr = p.metadata?.wc_attributes
        const hasAttr = Array.isArray(wcAttr) && wcAttr.length > 0

        console.log(`\n📦 Product: ${p.title} (${p.id})`)
        if (hasAttr) {
            console.log(`   ✅ Metadata Found: ${wcAttr.length} attributes waiting to be linked.`)
            console.log(`   Example: ${JSON.stringify(wcAttr[0].name)}`)
            foundCount++
        } else {
            console.log(`   ❌ No 'wc_attributes' in metadata.`)
            missingCount++
        }
    })

    console.log("\n📊 Summary:")
    console.log(`   - Verified: ${products.length}`)
    console.log(`   - Have Metadata: ${foundCount}`)
    console.log(`   - Missing Metadata: ${missingCount}`)
}
