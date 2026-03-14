export default async function ({ container }: any) {
    const productModuleService = container.resolve("productModuleService")

    // Get one product from the white LED category to trigger resync
    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    console.log(`🔄 Triggering filter resync by touching product...`)

    // Just update metadata to trigger middleware
    await productModuleService.updateProducts(productId, {
        metadata: { _sync_trigger: Date.now() }
    })

    console.log(`✅ Product updated - filters will resync in ~2 seconds (middleware debounce)`)
    console.log(`\n💡 Wait 3 seconds, then check category filters again`)
}
