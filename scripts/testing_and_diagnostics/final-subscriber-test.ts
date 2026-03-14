import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function ({ container }: ExecArgs) {
    console.log("🧪 FINAL TEST: Product Update Event")

    const productModule = container.resolve(Modules.PRODUCT)

    const [product] = await productModule.listProducts({}, {
        take: 1,
        select: ["id", "title"]
    })

    if (!product) {
        console.error("❌ No products")
        return
    }

    console.log(`📦 Product: ${product.title}`)
    console.log("🔄 Updating to trigger event...")

    await productModule.updateProducts({
        id: product.id,
        title: product.title
    })

    console.log("✅ Event fired. Check for: '⚡ EVENTO DETECTADO'")
    await new Promise(r => setTimeout(r, 3000))
}
