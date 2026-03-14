import { MedusaContainer } from "@medusajs/framework/types"

export default async function (container: MedusaContainer) {
    const query = container.resolve("query")

    console.log("\n" + "=".repeat(80))
    console.log("🔍 SHIPPING OPTIONS DIAGNOSTIC REPORT")
    console.log("=".repeat(80))

    // 1. Check shipping_option table
    const { data: shippingOptions } = await query.graph({
        entity: "shipping_option",
        fields: [
            "id",
            "name",
            "provider_id",
            "price_type",
            "amount",
            "data"
        ]
    })

    console.log(`\n📦 Found ${shippingOptions.length} shipping options:\n`)
    shippingOptions.forEach((opt: any, idx: number) => {
        console.log(`${idx + 1}. ${opt.name}`)
        console.log(`   ID: ${opt.id}`)
        console.log(`   Provider: ${opt.provider_id}`)
        console.log(`   Price Type: ${opt.price_type}`)
        console.log(`   Amount: ${opt.amount || 'NULL'}`)
        console.log(`   Data: ${JSON.stringify(opt.data)}`)
        console.log('')
    })

    // 2. Check fulfillment_provider table
    const { data: providers } = await query.graph({
        entity: "fulfillment_provider",
        fields: ["id", "is_enabled"]
    })

    console.log(`\n🚚 Found ${providers.length} fulfillment providers:\n`)
    providers.forEach((prov: any, idx: number) => {
        console.log(`${idx + 1}. ${prov.id} - Enabled: ${prov.is_enabled}`)
    })

    // 3. Check shipping_settings
    const { data: settings } = await query.graph({
        entity: "shipping_settings",
        fields: [
            "free_shipping_minimum",
            "regular_ground_shipping_price",
            "long_item_ground_shipping_price",
            "override_ups_ground"
        ]
    })

    console.log(`\n⚙️  Shipping Settings:\n`)
    if (settings.length > 0) {
        console.log(JSON.stringify(settings[0], null, 2))
    } else {
        console.log("⚠️  No shipping settings found")
    }

    console.log("\n" + "=".repeat(80))
    console.log("\n✅ Diagnostic complete!\n")
}
