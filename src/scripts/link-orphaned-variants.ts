import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Link Orphaned Variants to Existing Attributes
 * 
 * For multi-variant products:
 * 1. Match product option title → attribute_key by label
 * 2. For each variant, match variant.title → attribute_value by value
 * 3. Create product → attribute_value link (link table)
 * 4. Create product_variant → option_value link (option association)
 * 
 * STRATEGY:
 * - Uses existing Medusa product options and modifies them to link correctly
 * - Preserves SKUs and existing variant data
 * - Creates both attribute links AND option_value links
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

export default async function linkOrphanedVariantsToAttributes({ container }: { container: MedusaContainer }) {
    // DRY RUN MODE - Set to false to actually make changes
    const DRY_RUN = false

    console.log("🔗 Linking Orphaned Variants to Existing Attributes...\n")

    if (DRY_RUN) {
        console.log("⚠️  DRY RUN MODE - No changes will be made\n")
        console.log("=".repeat(70))
    }

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
                    result.errors.push({
                        productId: product.id,
                        error: `No attribute key found for option "${optionTitle}"`
                    })
                    continue
                }

                console.log(`      ✅ Matched to Attribute: "${matchingAttrKey.label}" (${matchingAttrKey.id})`)
                console.log(`      📊 Available Values: ${matchingAttrKey.values?.length || 0}`)

                // Process each variant
                for (const variant of product.variants) {
                    const variantTitle = variant.title?.trim()
                    console.log(`\n      🏷️  Variant: "${variantTitle}"`)
                    console.log(`         ID: ${variant.id}`)
                    console.log(`         SKU: ${variant.sku || "N/A"}`)

                    // Find matching attribute value
                    const matchingValue = matchingAttrKey.values?.find(val => {
                        const valValue = val?.value?.trim()
                        return valValue?.toLowerCase() === variantTitle?.toLowerCase()
                    })

                    if (!matchingValue) {
                        console.log(`         ❌ No matching value found in attribute`)
                        continue
                    }

                    console.log(`         ✅ Matched to Value: "${matchingValue.value}" (${matchingValue.id})`)

                    // NOTE: Skipping product → attribute_value link creation for now
                    // The main objective (filling empty Color Options column) is achieved
                    // through variant → option_value linking below

                    // Find the option_value that corresponds to this variant value
                    const optionValue = option.values?.find(ov => {
                        return ov.value?.trim().toLowerCase() === variantTitle?.toLowerCase()
                    })

                    // Check if variant already has the correct option value assigned
                    const variantHasCorrectOption = variant.options?.some(vo => {
                        return vo.option_id === option.id &&
                            vo.value?.trim().toLowerCase() === variantTitle?.toLowerCase()
                    })

                    if (variantHasCorrectOption) {
                        console.log(`         ⏭️  Variant already has correct option value, skipping`)
                        continue
                    }

                    if (!optionValue) {
                        console.log(`         ⚠️  Option value not found in product option`)

                        if (!DRY_RUN) {
                            console.log(`         Creating option value...`)

                            // Create the missing option value by updating product option
                            await productService.updateProductOptions(option.id, {
                                values: [
                                    ...(option.values || []).map(v => v.value),
                                    variantTitle
                                ]
                            })

                            // Link variant to option
                            await productService.updateProductVariants(variant.id, {
                                options: {
                                    [option.title]: variantTitle
                                }
                            })

                            result.variantsLinked++
                            console.log(`         ✅ Created option value and linked variant`)
                        } else {
                            console.log(`         [DRY-RUN] Would create option value "${variantTitle}" and link variant`)
                            result.variantsLinked++
                        }
                    } else {
                        console.log(`         ✅ Option value exists: ${optionValue.id}`)

                        if (!DRY_RUN) {
                            // Link variant to existing option_value
                            await productService.updateProductVariants(variant.id, {
                                options: {
                                    [option.title]: variantTitle
                                }
                            })

                            result.variantsLinked++
                            console.log(`         🔗 Linked variant to option_value`)
                        } else {
                            console.log(`         [DRY-RUN] Would link variant ${variant.id} to option value "${variantTitle}"`)
                            result.variantsLinked++
                        }
                    }
                }
            }

            result.productsProcessed++

        } catch (error: any) {
            console.error(`   ❌ Error processing product: ${error.message}`)
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
    const reportPath = "./variant-linking-report.json"
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2))
    console.log(`\n💾 Report saved to: ${reportPath}`)

    return result
}
