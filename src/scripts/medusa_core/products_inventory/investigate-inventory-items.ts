import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Investigate Inventory Item Schema
 * 
 * Checks what fields are available on inventory_item
 * and why title might not be displaying
 */

export default async function investigateInventoryItems({ container }: { container: MedusaContainer }) {
    console.log("🔍 Investigating Inventory Items Schema...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Get sample inventory items with all available fields
    const { data: items } = await query.graph({
        entity: "inventory_item",
        fields: [
            "id",
            "sku",
            "title",
            "description",
            "created_at",
            "metadata"
        ],
        pagination: {
            take: 5
        }
    })

    console.log(`📦 Sample Inventory Items (${items.length}):`)
    for (const item of items) {
        console.log(`\n  SKU: ${item.sku}`)
        console.log(`  ID: ${item.id}`)
        console.log(`  Title: ${item.title || "(empty)"}`)
        console.log(`  Description: ${item.description || "(empty)"}`)
    }

    // Check total count
    const { data: allItems } = await query.graph({
        entity: "inventory_item",
        fields: ["id", "sku", "title"]
    })

    const itemsWithTitle = allItems.filter(i => i.title)
    const itemsWithoutTitle = allItems.filter(i => !i.title)

    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 INVENTORY ITEMS ANALYSIS")
    console.log("=".repeat(70))
    console.log(`Total Items: ${allItems.length}`)
    console.log(`With Title: ${itemsWithTitle.length}`)
    console.log(`Without Title: ${itemsWithoutTitle.length}`)

    if (itemsWithoutTitle.length > 0) {
        console.log(`\n⚠️  ${itemsWithoutTitle.length} inventory items are missing titles!`)
        console.log(`\n💡 Solutions:`)
        console.log(`   1. Update inventory items to copy variant title`)
        console.log(`   2. Set title = SKU as fallback`)
        console.log(`   3. Link display should show variant title instead`)
    }

    return {
        total: allItems.length,
        withTitle: itemsWithTitle.length,
        withoutTitle: itemsWithoutTitle.length
    }
}
