import { sdk } from "./lib/sdk"

async function inspectProduct() {
    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    console.log("🔍 Inspecting Product:", productId)

    const { product } = await sdk.admin.product.retrieve(productId, {
        fields: "+options,+variants,+variants.options"
    })

    console.log("--- OPTIONS ---")
    console.log(JSON.stringify(product.options, null, 2))

    console.log("\n--- VARIANTS ---")
    product.variants.forEach(v => {
        console.log(`Variant: ${v.title} (ID: ${v.id})`)
        console.log(`   SKU: ${v.sku}`)
        console.log(`   Options:`, v.options)
    })
}

inspectProduct()
