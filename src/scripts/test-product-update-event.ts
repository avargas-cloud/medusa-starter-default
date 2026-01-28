import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function testProductUpdate({ container }: ExecArgs) {
    console.log("🧪 Testing Product Update Event Triggering...")

    const productModule = container.resolve(Modules.PRODUCT)

    // Find the specific product by handle
    const [product] = await productModule.listProducts({
        handle: ["100w-waterproof-meanwell-power-supply-24vdc"]
    })

    if (!product) {
        console.error("❌ Product not found")
        return
    }

    console.log(`📦 Found product: ${product.title} (${product.id})`)
    console.log(`   Current updated_at: ${product.updated_at}`)

    // Make a small update to trigger the event
    console.log("🔄 Updating product title (adding space)...")
    await productModule.updateProducts({
        id: product.id,
        title: product.title + " "  // Add space to trigger update
    })

    console.log("✅ Update command sent. Check terminal for subscriber logs...")
    console.log("   Look for: '⚡ [Product Subscriber] Triggering Workflow...'")

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Check if it actually updated
    const [updated] = await productModule.listProducts({ id: [product.id] })
    console.log(`   New updated_at: ${updated.updated_at}`)
}
