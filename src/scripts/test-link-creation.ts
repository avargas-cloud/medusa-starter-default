
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"

export default async function testLinkCreation({ container }: ExecArgs) {
    console.log("🛠️ Testing Link Creation...")

    // 1. Resolve Services
    const remoteLink = container.resolve("remoteLink")
    const attributeService = container.resolve(PRODUCT_ATTRIBUTES_MODULE)
    const productModule = container.resolve(Modules.PRODUCT)

    // 2. Get Targets
    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    // Get ANY attribute value
    const [attrKey] = await attributeService.listAttributeKeys({}, {
        relations: ["values"],
        take: 1
    })

    // Find a key that has values
    const [validKey] = await attributeService.listAttributeKeys({
        id: attrKey.id
    }, {
        relations: ["values"]
    }) // Re-query just to be safe or iterate if first is empty

    // Actually let's just search specifically for one we know might exist or create one
    // But better to list
    const allKeys = await attributeService.listAttributeKeys({}, { relations: ["values"], take: 10 })
    const value = allKeys.flatMap(k => k.values).find(v => v)

    if (!value) {
        console.error("❌ No attribute values found in DB! Cannot test linking.")
        return
    }

    console.log(`🎯 Targeting:`)
    console.log(`   Product: ${productId}`)
    console.log(`   AttributeValue: ${value.id} (Value: ${value.value})`)

    // 3. Try to Create Link
    try {
        console.log("🚀 Attempting remoteLink.create...")
        const links = await remoteLink.create([{
            [Modules.PRODUCT]: { product_id: productId },
            [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: value.id }
        }])
        console.log("✅ Success! Link created.")
        console.log(JSON.stringify(links, null, 2))
    } catch (e) {
        console.error("❌ Creation Failed:", e)
        const fs = require("fs")
        fs.writeFileSync("error_log.txt", JSON.stringify(e, Object.getOwnPropertyNames(e), 2))
    }

    // 4. Verify with List
    try {
        console.log("🔍 Verifying with remoteLink.list...")
        const listedRules = await remoteLink.list({
            [Modules.PRODUCT]: { product_id: productId }
        })
        console.log(`📋 Found ${listedRules.length} links after creation.`)
    } catch (e) {
        console.error("❌ Verification List Failed:", e)
    }
}
