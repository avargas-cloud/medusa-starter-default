import { ExecArgs } from "@medusajs/framework/types"
import { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
// import fetch from "node-fetch" // Not needed in newer node/medusa envs usually, using global fetch if avail or skipping to curl

export default async function findAndQueryProduct({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)
    const targetSku = "ESPFC4R4N50W0830"

    console.log(`🔍 Finding ListID for SKU: ${targetSku}...`)

    const [products] = await productService.listAndCountProducts(
        {},
        {
            select: ["id", "title", "variants.id", "variants.sku", "variants.metadata"],
            relations: ["variants"],
            take: 500
        }
    )

    let listId: any = null
    let productName = ""

    for (const p of products) {
        const variant = p.variants.find(v => v.sku === targetSku)
        if (variant) {
            productName = p.title
            listId = variant.metadata?.quickbooks_id
            console.log(`✅ Found Variant!`)
            console.log(`   Product: ${p.title}`)
            console.log(`   SKU: ${variant.sku}`)
            console.log(`   ListID: ${listId}`)
            break
        }
    }

    if (!listId) {
        console.log("❌ SKU not found in Medusa or has no ListID.")
        return
    }
}
