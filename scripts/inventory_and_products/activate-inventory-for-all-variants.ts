import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Activate Inventory for All Variants
 * 
 * Creates inventory items for all product variants and enables inventory management.
 * Sets initial stock to 0 (ready to be updated later via Excel or admin).
 */

interface InventoryResult {
    totalVariants: number
    inventoryItemsCreated: number
    alreadyHadInventory: number
    errors: Array<{
        variantId: string
        sku: string
        error: string
    }>
}

export default async function activateInventoryForAllVariants({ container }: { container: MedusaContainer }) {
    const DRY_RUN = false

    console.log("📦 Activating Inventory for All Variants...\n")
    if (DRY_RUN) {
        console.log("⚠️  DRY RUN MODE - No changes will be made\n")
    }

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const inventoryService = container.resolve(Modules.INVENTORY)

    // Get all variants
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

    const result: InventoryResult = {
        totalVariants: variants.length,
        inventoryItemsCreated: 0,
        alreadyHadInventory: 0,
        errors: [],
    }

    for (const variant of variants) {
        const sku = variant.sku || `NO-SKU-${variant.id}`

        try {
            // Check if variant already has inventory item
            if (variant.inventory_items && variant.inventory_items.length > 0) {
                console.log(`⏭️  ${sku}: Already has inventory item`)
                result.alreadyHadInventory++
                continue
            }

            if (!DRY_RUN) {
                // Create inventory item for this variant
                const inventoryItem = await inventoryService.createInventoryItems({
                    sku: sku,
                    // Initial stock will be 0, can be updated later via Excel or admin
                })

                // Link inventory item to variant
                const remoteLink = container.resolve("remoteLink")
                await remoteLink.create({
                    [Modules.PRODUCT]: {
                        variant_id: variant.id
                    },
                    [Modules.INVENTORY]: {
                        inventory_item_id: inventoryItem.id
                    }
                })

                // Enable inventory management on the variant
                const productService = container.resolve(Modules.PRODUCT)
                await productService.updateProductVariants(variant.id, {
                    manage_inventory: true
                })

                result.inventoryItemsCreated++
                console.log(`✅ ${sku}: Created inventory item & enabled management (${inventoryItem.id})`)
            } else {
                console.log(`[DRY-RUN] Would create inventory item for: ${sku}`)
                result.inventoryItemsCreated++
            }

        } catch (error: any) {
            console.error(`❌ ${sku}: ${error.message}`)
            result.errors.push({
                variantId: variant.id,
                sku: sku,
                error: error.message
            })
        }
    }

    // Print Summary
    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 INVENTORY ACTIVATION SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Variants: ${result.totalVariants}`)
    console.log(`Inventory Items Created: ${result.inventoryItemsCreated}`)
    console.log(`Already Had Inventory: ${result.alreadyHadInventory}`)
    console.log(`Errors: ${result.errors.length}`)

    if (result.errors.length > 0) {
        console.log(`\n❌ ERRORS:`)
        for (const error of result.errors) {
            console.log(`   ${error.sku}: ${error.error}`)
        }
    }

    if (result.inventoryItemsCreated > 0) {
        console.log(`\n✅ Inventory items created successfully!`)
        console.log(`📝 Note: All items start with 0 stock. Update quantities via admin or Excel upload.`)
    }

    // Save report
    const fs = await import("fs/promises")
    const reportPath = "./inventory-activation-report.json"
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2))
    console.log(`\n💾 Report saved to: ${reportPath}`)

    return result
}
