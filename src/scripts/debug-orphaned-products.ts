import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Debug Specific Products
 * Investigate the 2 products that have orphaned variants
 */

export default async function debugOrphanedProducts({ container }: { container: MedusaContainer }) {
    console.log("🔍 Debugging Orphaned Variant Products...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const productHandles = [
        "led-cob-mr16-with-gu5-3-base-7w",
        "led-par30-light-white-frame-10w-dimmable"
    ]

    for (const handle of productHandles) {
        console.log("=".repeat(70))
        console.log(`📦 Product: ${handle}`)
        console.log("=".repeat(70))

        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "handle",
                "variants.*",
                "variants.options.*",
                "options.*",
                "options.values.*",
            ],
            filters: { handle }
        })

        if (products.length === 0) {
            console.log("❌ Product not found!\n")
            continue
        }

        const product = products[0]
        console.log(`\nProduct ID: ${product.id}`)
        console.log(`Title: ${product.title}`)
        console.log(`Total Variants: ${product.variants?.length || 0}`)

        console.log(`\n📋 Product Options:`)
        if (product.options && product.options.length > 0) {
            for (const option of product.options) {
                console.log(`\n   🎛️  ${option.title} (ID: ${option.id})`)
                console.log(`      Values (${option.values?.length || 0}):`)
                if (option.values && option.values.length > 0) {
                    for (const val of option.values) {
                        console.log(`         - "${val.value}" (ID: ${val.id})`)
                    }
                } else {
                    console.log(`         (none)`)
                }
            }
        } else {
            console.log(`   ❌ No options defined`)
        }

        console.log(`\n📦 Variants:`)
        if (product.variants && product.variants.length > 0) {
            for (const variant of product.variants) {
                console.log(`\n   🏷️  ${variant.title} (SKU: ${variant.sku || "N/A"})`)
                console.log(`      ID: ${variant.id}`)
                console.log(`      Options (${variant.options?.length || 0}):`)
                if (variant.options && variant.options.length > 0) {
                    for (const vo of variant.options) {
                        console.log(`         - option_id: ${vo.option_id}`)
                        console.log(`           value: "${vo.value}"`)
                    }
                } else {
                    console.log(`         ❌ No options linked`)
                }
            }
        }

        console.log("\n")
    }
}
