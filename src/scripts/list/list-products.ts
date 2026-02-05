import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/framework/types"

export default async function listProducts({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("---------------------------------------------------")
    console.log("🔍 LISTING PRODUCTS (First 5)")
    console.log("---------------------------------------------------")

    const [products, count] = await productService.listAndCountProducts(
        {},
        {
            take: 5,
            relations: ["options", "variants", "variants.options"]
        }
    )

    console.log(`Total Products in DB: ${count}`)

    products.forEach(p => {
        console.log(`\n📦 Product: ${p.title} (ID: ${p.id})`)
        p.variants.forEach(v => {
            console.log(`   🔸 Variant: ${v.title} (SKU: ${v.sku})`)
            console.log(`      Options: ${v.options?.map(o => `${o.value} (OptID: ${o.option_id})`).join(", ")}`)
        })
    })
}
