import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function verifyProductSync({ container }: ExecArgs) {
    const productModule = container.resolve(Modules.PRODUCT)
    const logger = container.resolve("logger")

    // 1. Fetch a product
    const [product] = await productModule.listProducts({}, { take: 1 })
    if (!product) {
        logger.warn("No products found to test sync.")
        return
    }

    logger.info(`🔍 Testing sync for Product: ${product.title} (${product.id})`)

    // 2. Update the product title to trigger 'product.updated'
    const newTitle = product.title + " (Sync Test)"
    logger.info(`📝 Updating title to: ${newTitle}`)

    await productModule.updateProducts(
        { id: product.id },
        { title: newTitle }
    )

    logger.info("✅ Product updated. Check server logs for [Product Subscriber] output.")

    // Wait a bit to let the event propagate before reverting (optional)
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 3. Revert
    logger.info(`found original title: ${product.title}`)
    await productModule.updateProducts(
        { id: product.id },
        { title: product.title }
    )
    logger.info("✅ Reverted product title.")
}
