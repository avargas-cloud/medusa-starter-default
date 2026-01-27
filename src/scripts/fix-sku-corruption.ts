import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Fix SKU Corruption in Inventory Items
 * 
 * Problem: Some inventory_item SKUs have corrupted suffixes (e.g., "ESPFC4R4N50W0830esq11")
 * Solution: Sync inventory_item.sku with product_variant.sku
 */

export default async function fixSkuCorruption({ container }: { container: MedusaContainer }) {
    console.log("🔧 Fixing SKU Corruption in Inventory Items...\n")

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

    let fixed = 0
    let skipped = 0
    let errors = 0
    const corrupted: Array<{ variantSku: string; inventorySku: string }> = []

    for (const variant of variants) {
        if (!variant.inventory_items || variant.inventory_items.length === 0) {
            skipped++
            continue
        }

        const inventoryItemId = variant.inventory_items[0]?.inventory_item_id
        const currentInventorySku = variant.inventory_items[0]?.inventory?.sku

        if (!inventoryItemId) {
            skipped++
            continue
        }

        // Check if SKUs match
        if (variant.sku !== currentInventorySku) {
            corrupted.push({
                variantSku: variant.sku,
                inventorySku: currentInventorySku
            })

            console.log(`🔴 MISMATCH FOUND:`)
            console.log(`   Variant SKU:   ${variant.sku}`)
            console.log(`   Inventory SKU: ${currentInventorySku}`)
            console.log(`   → Fixing to: ${variant.sku}\n`)

            try {
                await inventoryService.updateInventoryItems({
                    id: inventoryItemId,
                    sku: variant.sku
                })

                fixed++
            } catch (error: any) {
                console.error(`❌ ${variant.sku}: ${error.message}`)
                errors++
            }
        }
    }

    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Variants: ${variants.length}`)
    console.log(`Corrupted SKUs Found: ${corrupted.length}`)
    console.log(`Fixed: ${fixed}`)
    console.log(`Skipped (no inventory): ${skipped}`)
    console.log(`Errors: ${errors}`)

    if (corrupted.length > 0) {
        console.log(`\n🔴 Corrupted SKUs Details:`)
        corrupted.forEach(({ variantSku, inventorySku }) => {
            console.log(`   ${inventorySku} → ${variantSku}`)
        })
    }

    console.log(`\n✅ Done! Refresh the Inventory page in admin.`)

    return { fixed, skipped, errors, corrupted }
}
