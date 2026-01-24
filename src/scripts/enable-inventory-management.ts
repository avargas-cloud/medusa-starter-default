import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Enable Inventory Management for All Variants
 * 
 * Sets manage_inventory = true for all variants that already have inventory items linked.
 * Run this AFTER creating inventory items.
 */

export default async function enableInventoryManagement({ container }: { container: MedusaContainer }) {
    console.log("🔧 Enabling Inventory Management for All Variants...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productService = container.resolve(Modules.PRODUCT)

    // Get all variants with their inventory items
    const { data: variants } = await query.graph({
        entity: "product_variant",
        fields: [
            "id",
            "title",
            "sku",
            "manage_inventory",
            "inventory_items.*"
        ],
    })

    console.log(`📊 Found ${variants.length} total variants\n`)

    let updated = 0
    let alreadyManaged = 0
    let noInventoryItem = 0

    for (const variant of variants) {
        const sku = variant.sku || `NO-SKU-${variant.id}`

        // Check if has inventory item
        if (!variant.inventory_items || variant.inventory_items.length === 0) {
            console.log(`⏭️  ${sku}: No inventory item linked`)
            noInventoryItem++
            continue
        }

        // Check if already managed
        if (variant.manage_inventory === true) {
            console.log(`⏭️  ${sku}: Already managed`)
            alreadyManaged++
            continue
        }

        // Enable management
        await productService.updateProductVariants(variant.id, {
            manage_inventory: true
        })

        updated++
        console.log(`✅ ${sku}: Enabled inventory management`)
    }

    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Variants: ${variants.length}`)
    console.log(`Updated: ${updated}`)
    console.log(`Already Managed: ${alreadyManaged}`)
    console.log(`No Inventory Item: ${noInventoryItem}`)

    console.log(`\n✅ Done! Refresh the admin to see changes.`)

    return { updated, alreadyManaged, noInventoryItem }
}
