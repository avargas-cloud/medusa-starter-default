
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function debugProductMetadata({ container }: ExecArgs) {
    const productModule = container.resolve(Modules.PRODUCT)
    const productId = "prod_100w-indoor-meanwell-power-supply-24vdc"

    console.log(`🔍 Inspecting metadata for ${productId}...`)

    const [product] = await productModule.listProducts({ id: productId }, {
        select: ["id", "title", "metadata"]
    })

    if (!product) {
        console.error("❌ Product not found!")
        return
    }

    console.log("📄 Raw Metadata:")
    console.log(JSON.stringify(product.metadata, null, 2))

    const wcAttr = product.metadata?.wc_attributes
    console.log("\n🧪 Analysis:")
    console.log(`- wc_attributes exists? ${!!wcAttr}`)
    console.log(`- Is Array? ${Array.isArray(wcAttr)}`)
    if (Array.isArray(wcAttr)) {
        console.log(`- Length: ${wcAttr.length}`)
        console.log(`- First Item:`, wcAttr[0])
    }
}
