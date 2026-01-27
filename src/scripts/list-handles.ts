import { ExecArgs } from "@medusajs/framework/types"
import { IProductModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function listAllProducts({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("🔍 Listing all product handles...")

    const [products] = await productService.listAndCountProducts(
        {},
        {
            select: ["title", "handle"],
            take: 500,
        }
    )

    products.forEach(p => {
        if (p.handle.includes("strip") || p.handle.includes("neon") || p.handle.includes("code")) {
            console.log(`Potential Match: ${p.title} (${p.handle})`)
        }
    })
}
