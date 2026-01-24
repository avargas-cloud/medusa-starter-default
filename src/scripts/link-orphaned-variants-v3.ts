import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Link Orphaned Variants to Existing Attributes - V3
 * 
 * 3-PHASE APPROACH to avoid race conditions:
 * Phase 1: Collect all required option values for each product
 * Phase 2: Batch create ALL missing option values
 * Phase 3: Link ALL variants to their option values
 */

interface LinkingResult {
    totalProducts: number
    productsProcessed: number
    variantsLinked: number
    errors: Array<{
        productId: string
        error: string
    }>
    skipped: Array<{
        productId: string
        reason: string
    }>
}

export default async function linkOrphanedVariantsToAttributesV3({ container }: { container: MedusaContainer }) {
    const DRY_RUN = false

    console.log("🔗 Linking Orphaned Variants (V3 - 3-Phase Approach)...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productService = container.resolve(Modules.PRODUCT)

    // Get all attribute keys and values
    const { data: attributeKeys } = await query.graph({
        entity: "attribute_key",
        fields: [
            "id",
            "label",
            "handle",
            "values.*",
        ],
    })

    console.log(`📚 Loaded ${attributeKeys.length} Attribute Keys\n`)

    // Get multi-variant products
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
    })

    const multiVariantProducts = products.filter(p => p.variants?.length > 1)
    console.log(`📦 Processing ${multiVariantProducts.length} Multi-Variant Products\n`)

    const result: LinkingResult = {
        totalProducts: multiVariantProducts.length,
        productsProcessed: 0,
        variantsLinked: 0,
        errors: [],
        skipped: [],
    }

    for (const product of multiVariantProducts) {
        console.log(`\n${"=".repeat(70)}`)
        console.log(`📦 Processing: ${product.title}`)
        console.log(`   ID: ${product.id}`)

        if (!product.options || product.options.length === 0) {
            console.log(`   ⏭️  SKIP: No product options defined`)
            result.skipped.push({
                productId: product.id,
                reason: "No product options"
            })
            continue
        }

        try {
            for (const option of product.options) {
                const optionTitle = option.title?.trim()
                console.log(`\n   🎛️  Option: "${optionTitle}"`)

                // Find matching attribute key
                const matchingAttrKey = attributeKeys.find(key => {
                    const keyLabel = key.label?.trim()
                    return keyLabel?.toLowerCase() === optionTitle?.toLowerCase()
                })

                if (!matchingAttrKey) {
                    console.log(`      ❌ No matching attribute key found`)
                    continue
                }

                console.log(`      ✅ Matched to Attribute: "${matchingAttrKey.label}"`)

                // PHASE 1: Collect ALL variant values that need option_values
                const variantsToLink: Array<{
                    variant: any
                    variantTitle: string
                    matchingValue: any
                    needsOptionValue: boolean
                }> = []
                const existingOptionValues = new Set(
                    (option.values || []).map(v => v.value?.trim().toLowerCase())
                )

                for (const variant of product.variants) {
                    const variantTitle = variant.title?.trim()

                    // Check if already correctly linked
                    const alreadyLinked = variant.options?.some(vo =>
                        vo.option_id === option.id &&
                        vo.value?.trim().toLowerCase() === variantTitle?.toLowerCase()
                    )

                    if (alreadyLinked) {
                        continue
                    }

                    // Check if matches attribute value
                    const matchingValue = matchingAttrKey.values?.find(val =>
                        val?.value?.trim().toLowerCase() === variantTitle?.toLowerCase()
                    )

                    if (matchingValue) {
                        variantsToLink.push({
                            variant,
                            variantTitle,
                            matchingValue,
                            needsOptionValue: !existingOptionValues.has(variantTitle.toLowerCase())
                        })
                    }
                }

                if (variantsToLink.length === 0) {
                    console.log(`      ℹ️  All variants already linked`)
                    continue
                }

                // PHASE 2: Batch create ALL missing option values
                const newValues = variantsToLink
                    .filter(v => v.needsOptionValue)
                    .map(v => v.variantTitle)

                if (newValues.length > 0 && !DRY_RUN) {
                    console.log(`\n      📝 Creating ${newValues.length} new option values: ${newValues.join(", ")}`)

                    await productService.updateProductOptions(option.id, {
                        values: [
                            ...(option.values || []).map(v => v.value),
                            ...newValues
                        ]
                    })

                    console.log(`      ✅ Option values created`)
                }

                // PHASE 3: Link ALL variants
                console.log(`\n      🔗 Linking ${variantsToLink.length} variants...`)

                for (const { variant, variantTitle } of variantsToLink) {
                    if (!DRY_RUN) {
                        await productService.updateProductVariants(variant.id, {
                            options: {
                                [option.title]: variantTitle
                            }
                        })
                        result.variantsLinked++
                    } else {
                        console.log(`         [DRY-RUN] Would link: ${variantTitle}`)
                    }
                }

                console.log(`      ✅ Linked ${variantsToLink.length} variants`)
            }

            result.productsProcessed++

        } catch (error: any) {
            console.error(`   ❌ Error: ${error.message}`)
            result.errors.push({
                productId: product.id,
                error: error.message
            })
        }
    }

    // Print Summary
    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 MIGRATION SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Products: ${result.totalProducts}`)
    console.log(`Successfully Processed: ${result.productsProcessed}`)
    console.log(`Variants Linked: ${result.variantsLinked}`)
    console.log(`Skipped: ${result.skipped.length}`)
    console.log(`Errors: ${result.errors.length}`)

    if (result.errors.length > 0) {
        console.log(`\n❌ ERRORS:`)
        for (const error of result.errors) {
            console.log(`   ${error.productId}: ${error.error}`)
        }
    }

    if (result.skipped.length > 0) {
        console.log(`\n⏭️  SKIPPED:`)
        for (const skip of result.skipped) {
            console.log(`   ${skip.productId}: ${skip.reason}`)
        }
    }

    // Save report
    const fs = await import("fs/promises")
    const reportPath = "./variant-linking-v3-report.json"
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2))
    console.log(`\n💾 Report saved to: ${reportPath}`)

    return result
}
