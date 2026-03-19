import { ExecArgs } from "@medusajs/framework/types"
import { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"

export default async function findTestProduct({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("🔍 Searching for 'ulfreecode-eligistrip' variants...")

    const [products] = await productService.listAndCountProducts(
        {
            q: "ulfreecode-eligistrip" // Searching by query
        },
        {
            select: ["id", "title", "handle", "variants.id", "variants.sku", "variants.title", "variants.metadata"],
            relations: ["variants"]
        }
    )

    if (products.length === 0) {
        console.log("❌ Product not found by search query.")
        return
    }

    products.forEach(p => {
        console.log(`\n📦 Product: ${p.title} (${p.handle})`)
        p.variants.forEach(v => {
            if (v.sku?.endsWith("30") || v.title?.includes("3000K")) {
                console.log(`\n🎯 TARGET FOUND:`)
                console.log(`   SKU: ${v.sku}`)
                console.log(`   Variant Title: ${v.title}`)
                console.log(`   Medusa ID: ${v.id}`)
                console.log(`   QB ListID: ${v.metadata?.quickbooks_id || "MISSING"}`)
            } else {
                console.log(`   - SKU: ${v.sku} (Not target)`)
            }
        })
    })
}
