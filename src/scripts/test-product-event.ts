import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function ({ container }: ExecArgs) {
    console.log("🧪 Testing Product.Updated Event...")

    const productModule = container.resolve(Modules.PRODUCT)

    // Find a product
    const [product] = await productModule.listProducts({}, {
        take: 1,
        select: ["id", "title", "updated_at"]
    })

    if (!product) {
        console.error("❌ No products found")
        return
    }

    console.log(`📦 Found: ${product.title} (${product.id})`)
    console.log(`   Current updated_at: ${product.updated_at}`)

    // Make a minimal update
    console.log("🔄 Triggering product.updated event...")
    await productModule.updateProducts({
        id: product.id,
        title: product.title // Same value to trigger event without changing data
    })

    console.log("✅ Event should have fired!")
    console.log("   Look for: '⚡ EVENTO DETECTADO: product.updated'")

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 3000))

    console.log("⏰ Done waiting. Check terminal logs above.")
}
