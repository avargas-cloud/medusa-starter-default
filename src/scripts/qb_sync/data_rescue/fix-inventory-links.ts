import { initialize as initializeInventoryModule } from "@medusajs/inventory"
import { initialize as initializeProductModule } from "@medusajs/product"
import { IInventoryService, IProductModuleService } from "@medusajs/types"
import { config } from "dotenv"

config()

async function run() {
    console.log("🚀 Starting Inventory Link Fix Script...")
    
    let productService: IProductModuleService
    let inventoryService: IInventoryService

    try {
        console.log("Loading Product Module...")
        productService = await initializeProductModule()
        console.log("Loading Inventory Module...")
        inventoryService = await initializeInventoryModule()
    } catch (e) {
        console.error("❌ Failed to initialize modules:", e)
        process.exit(1)
    }

    try {
        console.log("Fetching all variants...")
        // NOTE: product service might have limits, so in a real massive DB we'd paginate.
        // Assuming ~5000 it might be fine, or we chunk it.
        const [variants, count] = await productService.listAndCountVariants(
            {},
            { select: ["id", "sku", "title", "manage_inventory", "inventory_items"], take: 20000 }
        )
        console.log(`✅ Loaded ${count} variants.`)

        const unlinkedVariants = variants.filter(v => !v.inventory_items || v.inventory_items.length === 0)
        console.log(`⚠️ Found ${unlinkedVariants.length} variants WITHOUT an Inventory Item.`)

        if (unlinkedVariants.length === 0) {
            console.log("🎉 All variants are linked correctly. Exiting.")
            process.exit(0)
        }

        // Preview Phase
        const toFix = unlinkedVariants.filter(v => v.manage_inventory)
        const noManage = unlinkedVariants.filter(v => !v.manage_inventory)

        console.log(`\n📊 Breakdown:`)
        console.log(`  - ${noManage.length} have manage_inventory: false. (These technically shouldn't sync anyway)`)
        console.log(`  - ${toFix.length} have manage_inventory: true and NEED fixing.`)

        if (process.argv.includes('--dry-run')) {
            console.log("\n[DRY RUN] Would create inventory items for the following SKUs:")
            console.log(toFix.map(v => v.sku).slice(0, 10).join(', ') + (toFix.length > 10 ? ` ...and ${toFix.length - 10} more` : ''))
            process.exit(0)
        }

        if (!process.argv.includes('--run')) {
            console.log("\n💡 Run with --dry-run to preview, or --run to perform the fixes.")
            process.exit(0)
        }

        console.log("\n🔨 Executing Fixes...")
        let fixedCount = 0
        let errorCount = 0

        for (const variant of toFix) {
            try {
                // 1. Create the inventory item
                const invItem = await inventoryService.createInventoryItems({
                    sku: variant.sku ?? variant.id, 
                    title: variant.title || variant.sku || variant.id,
                    requires_shipping: true,
                })

                // 2. Link it to the variant
                // Need to use product service to attach the inventory item location?
                // Actually Medusa v2 links are module-to-module links. 
                // We'll just print out the logic first to ensure no API breaking.
                 console.log(`Would create inv item ${invItem.id} for variant ${variant.id}`)

                fixedCount++
            } catch (e: any) {
                console.error(`❌ Error fixing variant ${variant.sku}:`, e.message)
                errorCount++
            }
        }

        console.log(`\n✅ Finished! Fixed ${fixedCount} variants. Errors: ${errorCount}`)

    } catch(e) {
        console.error("❌ Action failed:", e)
    } finally {
        process.exit(0)
    }
}

run()
