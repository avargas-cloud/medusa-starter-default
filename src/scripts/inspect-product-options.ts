import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/framework/types"

export default async function inspectProductOptions({ container }: ExecArgs) {
    const productService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log("---------------------------------------------------")
    console.log("🔍 INSPECTING PRODUCT: ECLDL-3R7WS60K")
    console.log("---------------------------------------------------")

    // 1. Find the product via the variant SKU
    const [variants] = await productService.listProductVariants(
        { sku: "ECLDL-3R7WS60K" },
        { relations: ["product", "options", "product.options"] }
    )

    if (!variants.length) {
        console.log("❌ Variant not found!")
        return
    }

    const variant = variants[0]
    const product = variant.product

    // 2. Print Product Options (The "Definitions")
    console.log("\n📋 PRODUCT OPTIONS (Definitions):")
    product.options.forEach((opt) => {
        console.log(`   - ID: ${opt.id}`)
        console.log(`     Title: "${opt.title}"`)
        console.log(`     Values: ${opt.values ? opt.values.length : 'N/A'}`)
    })

    // 3. Print Variant Options (The "Values" assigned to this variant)
    console.log("\n🧩 VARIANT OPTION VALUES (Assigned):")
    console.log(`   Variant Title: "${variant.title}"`)
    console.log(`   Variant ID: ${variant.id}`)

    if (variant.options && variant.options.length > 0) {
        variant.options.forEach((val) => {
            console.log(`   - Value: "${val.value}"`)
            console.log(`     Linked to Option ID: ${val.option_id}`)

            // Check for mismatch
            const parentOption = product.options.find(o => o.id === val.option_id)
            if (parentOption) {
                console.log(`     ✅ Valid Link -> Product Option "${parentOption.title}"`)
            } else {
                console.log(`     ⚠️ ORPHANED LINK -> Option ID ${val.option_id} does not exist on this product!`)
            }
        })
    } else {
        console.log("   ⚠️ NO OPTIONS ASSIGNED to this variant (Empty Array)")
    }

    console.log("\n---------------------------------------------------")
}
