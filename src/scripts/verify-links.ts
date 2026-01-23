
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/framework/types"

export default async function verifyLinks({ container }: ExecArgs) {
    const productModule: IProductModuleService = container.resolve(Modules.PRODUCT)
    const remoteLink = container.resolve("remoteLink")

    // 1. Get the target product (Power Supply) or first one with wc_attributes
    const products = await productModule.listProducts({}, {
        take: 10,
        select: ["id", "title", "metadata"]
    })

    const targetProduct = products.find(p => p.metadata?.wc_attributes) || products[0]

    if (!targetProduct) {
        console.log("❌ No products found to verify.")
        return
    }

    console.log(`\n🔍 Verifying Product: ${targetProduct.title} (${targetProduct.id})`)

    // 2. Check metadata
    const wcAttributes = targetProduct.metadata?.wc_attributes as any[]
    console.log(`📋 Metadata 'wc_attributes': ${wcAttributes?.length || 0} items found.`)
    if (wcAttributes?.length > 0) {
        console.log("   Sample:", JSON.stringify(wcAttributes[0], null, 0))
    }

    // 3. Check actual Medusa Links using RemoteLink
    // We look for links where the product module is involved with this product ID
    const links = await remoteLink.list({
        [Modules.PRODUCT]: { product_id: targetProduct.id }
    })

    // Filter for links that connect to our custom module (productAttributes or similar)
    // The keys in the link object will reveal the connected modules.
    const attributeLinks = links.filter(link => {
        // We look for any key that looks like our module
        return Object.keys(link).some(k => k.toLowerCase().includes("attribute"))
    })

    console.log(`🔗 Total Links for Product: ${links.length}`)
    console.log(`🔗 Attribute Links Found: ${attributeLinks.length}`)

    if (attributeLinks.length > 0) {
        console.log("   ✅ Links exist! Sample:", JSON.stringify(attributeLinks[0], null, 2))
    } else {
        console.log("   ❌ No attribute links found.")
    }

    // 4. Comparison
    if (wcAttributes?.length > 0 && attributeLinks.length === 0) {
        console.log("\n⚠️ MISMATCH: Metadata has attributes, but Medusa links are empty.")
        console.log("   👉 RUN MIGRATION: npx medusa exec ./src/scripts/migrate-product-attributes.ts")
    } else if (wcAttributes?.length > 0 && attributeLinks.length > 0) {
        console.log("\n✅ MATCH: Attributes appear to be migrated.")
    }
}
