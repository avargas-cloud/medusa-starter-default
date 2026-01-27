import { ExecArgs } from "@medusajs/framework/types"
import { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function inspectMetadata({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("🔍 Inspecting Metadata for first 5 products...")

    const [products] = await productService.listAndCountProducts(
        {},
        {
            select: ["id", "title", "handle", "metadata", "variants.id", "variants.sku", "variants.metadata"],
            take: 5,
            relations: ["variants"]
        }
    )

    products.forEach(p => {
        console.log(`\n📦 Product: ${p.title} (${p.handle})`)
        console.log("Product Metadata:", JSON.stringify(p.metadata, null, 2))

        if (p.variants && p.variants.length > 0) {
            console.log(`🔹 Variants (${p.variants.length}):`)
            p.variants.forEach(v => {
                console.log(`   - SKU: ${v.sku} | ID: ${v.id}`)
                console.log(`     Metadata:`, JSON.stringify(v.metadata, null, 2))
            })
        } else {
            console.log("⚠️ No variants found for this product.")
        }
    })
}
