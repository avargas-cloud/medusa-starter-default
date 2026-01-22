
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function debugLinks({ container }: ExecArgs) {
    try {
        console.log("🔍 Debugging Remote Links...")
        const remoteLink = container.resolve("remoteLink")
        const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

        const links = await remoteLink.list({
            [Modules.PRODUCT]: { product_id: productId }
        }, {
            take: 999
        })

        console.log(`🔗 Found ${links.length} remote links for product ${productId}.`)
        if (links.length > 0) {
            console.log(JSON.stringify(links, null, 2))
        } else {
            console.log("⚠️ No links found. Checking if product exists...")
            const productModule = container.resolve(Modules.PRODUCT)
            const [product] = await productModule.listProducts({ id: productId })
            if (product) {
                console.log(`✅ Product exists: ${product.title}`)
            } else {
                console.log(`❌ Product NOT found with ID: ${productId}`)
            }
        }
    } catch (e) {
        console.error("❌ Link Query Failed:", e)
    }
}
