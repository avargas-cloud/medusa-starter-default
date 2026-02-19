/**
 * check-dim-source.ts
 * Checks where the shipping dimensions for a given SKU come from
 * Usage: npx medusa exec src/scripts/check-dim-source.ts
 */
export default async function checkDimSource({ container }: { container: any }) {
    const knex = container.resolve("__pg_connection__") as any
    const SKU = "ECNA-DC-4PW-B"

    console.log(`\n🔍 Checking dimension sources for SKU: ${SKU}\n`)

    // 1. product_variant fields
    const variant = await knex("product_variant as pv")
        .join("product as p", "p.id", "pv.product_id")
        .where("pv.sku", SKU)
        .select("pv.id as variant_id", "pv.title", "pv.weight", "pv.height", "pv.width", "pv.length", "p.id as product_id", "p.title as product_title")
        .first()

    console.log("📦 product_variant fields:")
    console.log(`   weight=${variant?.weight}  height=${variant?.height}  width=${variant?.width}  length=${variant?.length}`)

    // 2. product metadata (if any shipping dims stored there)
    const productMeta = await knex("product").where("id", variant?.product_id).select("metadata").first()
    console.log("\n📋 product.metadata (shipping-related keys):")
    const meta = productMeta?.metadata || {}
    const shippingKeys = Object.keys(meta).filter(k => /weight|height|width|length|dim|ship/i.test(k))
    if (shippingKeys.length > 0) {
        shippingKeys.forEach(k => console.log(`   ${k}: ${meta[k]}`))
    } else {
        console.log("   (none found)")
    }

    // 3. product_to_attribute table
    const attrs = await knex("product_to_attribute")
        .where("product_id", variant?.product_id)
        .select("attribute_key", "attribute_value")

    console.log("\n🏷️  product_to_attribute rows:")
    if (attrs.length > 0) {
        attrs.forEach((a: any) => console.log(`   ${JSON.stringify(a.attribute_key)}: ${a.attribute_value}`))
    } else {
        console.log("   (none found)")
    }

    // 4. inventory_item current state
    const inv = await knex("product_variant_inventory_item as pvi")
        .join("inventory_item as ii", "ii.id", "pvi.inventory_item_id")
        .where("pvi.variant_id", variant?.variant_id)
        .select("ii.id", "ii.sku", "ii.weight", "ii.height", "ii.width", "ii.length")
        .first()

    console.log("\n🏭 inventory_item current values:")
    console.log(`   weight=${inv?.weight}  height=${inv?.height}  width=${inv?.width}  length=${inv?.length}`)

    await knex.destroy?.()
}
