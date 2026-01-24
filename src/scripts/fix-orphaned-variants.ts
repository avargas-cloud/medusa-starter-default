import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Fix Specific Orphaned Variants
 * 
 * Manually fixes the 2 orphaned variants found in audit:
 * 1. LED COB MR16 - variant 5000K
 * 2. LED Par30 Light - variant 5000K
 */

export default async function fixOrphanedVariants({ container }: { container: MedusaContainer }) {
    console.log("🔧 Fixing Known Orphaned Variants...\n")

    const productService = container.resolve(Modules.PRODUCT)

    const orphanedVariants = [
        {
            productHandle: "led-cob-mr16-with-gu5-3-base-7w",
            variantId: "variant_led-cob-mr16-with-gu5-3-base-7w_19281",
            variantTitle: "5000K",
            optionTitle: "Color Options",
            sku: "SUN-81121"
        },
        {
            productHandle: "led-par30-light-white-frame-10w-dimmable",
            variantId: "variant_led-par30-light-white-frame-10w-dimmable_8326",
            variantTitle: "5000K",
            optionTitle: "Color Options",
            sku: "SUN-80897"
        }
    ]

    let fixed = 0
    let errors = 0

    for (const orphan of orphanedVariants) {
        console.log(`📦 Processing: ${orphan.productHandle}`)
        console.log(`   Variant: ${orphan.variantTitle} (SKU: ${orphan.sku})`)

        try {
            // Link variant to option
            await productService.updateProductVariants(orphan.variantId, {
                options: {
                    [orphan.optionTitle]: orphan.variantTitle
                }
            })

            fixed++
            console.log(`   ✅ Fixed!\n`)
        } catch (error: any) {
            errors++
            console.error(`   ❌ Error: ${error.message}\n`)
        }
    }

    console.log("=".repeat(70))
    console.log("📊 SUMMARY")
    console.log("=".repeat(70))
    console.log(`Fixed: ${fixed}`)
    console.log(`Errors: ${errors}`)
    console.log("")

    if (fixed === orphanedVariants.length) {
        console.log("✅ All orphaned variants fixed successfully!")
    } else {
        console.log("⚠️  Some variants could not be fixed. Check errors above.")
    }

    return { fixed, errors }
}
