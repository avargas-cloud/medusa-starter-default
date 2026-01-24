import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Fix Inventory Item Titles
 * 
 * Copies variant title to inventory_item.title
 * This makes inventory items easier to identify in admin
 */

export default async function fixInventoryItemTitles({ container }: { container: MedusaContainer }) {
    console.log("🔧 Fixing Inventory Item Titles...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const inventoryService = container.resolve(Modules.INVENTORY)

    // Get all variants with their inventory items
    const { data: variants } = await query.graph({
        entity: "product_variant",
        fields: [
            "id",
            "title",
            "sku",
            "product.title",
            "inventory_items.inventory_item_id",
            "inventory_items.inventory.id",
            "inventory_items.inventory.sku"
        ],
    })

    console.log(`📊 Found ${variants.length} variants\n`)

    let updated = 0
    let skipped = 0
    let errors = 0

    for (const variant of variants) {
        if (!variant.inventory_items || variant.inventory_items.length === 0) {
            skipped++
            continue
        }

        // Get the inventory_item_id from the link
        const inventoryItemId = variant.inventory_items[0]?.inventory_item_id

        if (!inventoryItemId) {
            console.error(`⚠️  ${variant.sku}: No inventory_item_id found`)
            skipped++
            continue
        }

        // Build title: "Product Title - Variant Title"
        const productTitle = variant.product?.title || "Unknown Product"
        const variantTitle = variant.title || variant.sku || "Unknown Variant"
        const newTitle = `${productTitle} - ${variantTitle}`

        try {
            await inventoryService.updateInventoryItems({
                id: inventoryItemId,
                title: newTitle,
                description: `SKU: ${variant.sku}`
            })

            updated++
            if (updated <= 10) {
                console.log(`✅ ${variant.sku}: "${newTitle}"`)
            } else if (updated === 11) {
                console.log(`   ... (showing first 10, continuing...)`)
            }

        } catch (error: any) {
            console.error(`❌ ${variant.sku}: ${error.message}`)
            errors++
        }
    }

    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Variants: ${variants.length}`)
    console.log(`Updated: ${updated}`)
    console.log(`Skipped (no inventory): ${skipped}`)
    console.log(`Errors: ${errors}`)

    console.log(`\n✅ Done! Refresh the Inventory page in admin to see titles.`)

    return { updated, skipped, errors }
}
