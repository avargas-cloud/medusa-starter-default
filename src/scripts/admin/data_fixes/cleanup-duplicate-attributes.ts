import { Modules } from "@medusajs/utils"

export default async function cleanupDuplicateAttributes({ container }: any) {
    const query = container.resolve("query")
    const remoteLink = container.resolve("remoteLink")
    const productId = "prod_ul-freecut-cob-led-strip-single-color-bright-output"

    console.log("🔧 CLEANING UP DUPLICATE ATTRIBUTES")
    console.log("=".repeat(80))

    // 1. Get current attribute links
    const { data: links } = await query.graph({
        entity: "product_attribute_value",
        fields: ["attribute_value_id"],
        filters: { product_id: productId }
    })

    const valueIds = links.map((l: any) => l.attribute_value_id)

    console.log(`📊 Found ${valueIds.length} attribute links`)

    // 2. Get full value details
    const { data: values } = await query.graph({
        entity: "attribute_value",
        fields: ["id", "value", "attribute_key_id", "attribute_key.handle"],
        filters: { id: valueIds }
    })

    // 3. Group by attribute_key
    const byKey = new Map<string, any[]>()
    values.forEach((v: any) => {
        const keyId = v.attribute_key_id
        if (!byKey.has(keyId)) {
            byKey.set(keyId, [])
        }
        byKey.get(keyId)!.push(v)
    })

    console.log(`\n📂 Found ${byKey.size} unique attribute keys`)

    // 4. Find duplicates and keep the LAST one (most recent)
    const toDelete: string[] = []
    byKey.forEach((vals, keyId) => {
        if (vals.length > 1) {
            const handle = vals[0].attribute_key.handle
            console.log(`\n⚠️  Key "${handle}" has ${vals.length} values:`)
            vals.forEach((v: any) => console.log(`   - ${v.value} (ID: ${v.id})`))

            // Keep the last value, delete all others
            const toKeep = vals[vals.length - 1]
            const toRemove = vals.slice(0, -1)

            console.log(`   ✅ Keeping: ${toKeep.value}`)
            console.log(`   ❌ Deleting: ${toRemove.map(v => v.value).join(", ")}`)

            toDelete.push(...toRemove.map(v => v.id))
        }
    })

    if (toDelete.length === 0) {
        console.log("\n✅ No duplicates found!")
        return
    }

    console.log(`\n🗑️  Deleting ${toDelete.length} duplicate attribute links...`)

    await remoteLink.delete({
        [Modules.PRODUCT]: { product_id: productId },
        [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: toDelete }
    })

    console.log("✅ Cleanup complete!")
    console.log("=".repeat(80))
}

const PRODUCT_ATTRIBUTES_MODULE = "productAttributesLink"
