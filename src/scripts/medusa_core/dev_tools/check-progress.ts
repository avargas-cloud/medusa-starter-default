
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function checkSpecificProduct({ container }: ExecArgs) {
    const remoteLink = container.resolve("remoteLink")
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc" // User said this one was empty

    console.log(`🔍 Checking links for ${productId}...`)

    // Check specific product
    const links = await remoteLink.list({
        [Modules.PRODUCT]: { product_id: productId }
    })

    console.log(`✅ Links found: ${links.length}`)
    if (links.length > 0) {
        console.log("Migration HAS reached this product.")
    } else {
        console.log("Migration has NOT yet reached this product (or failed).")
    }
}
