import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Link Products to Attribute Values (Option-Based)
 * 
 * For multi-variant products:
 * 1. Match product options (e.g., "Color Options") with attribute keys
 * 2. Collect all variant option values (e.g., "3000K", "4000K", "5000K")
 * 3. Link product to corresponding attribute_values
 * 4. Mark attribute key as variant-level in product.metadata
 * 
 * This populates the "Product Attributes" widget with actual values
 * and shows checkmark in "Variant?" column
 */

interface LinkingResult {
    totalProducts: number
    productsProcessed: number
    attributeValuesLinked: number
    variantKeysMarked: number
    errors: Array<{
        productId: string
        error: string
    }>
}

export default async function linkProductsToAttributeValues({ container }: { container: MedusaContainer }) {
    const DRY_RUN = false

    console.log("🔗 Linking Products to Attribute Values (Option-Based)...\n")
    if (DRY_RUN) {
        console.log("⚠️  DRY RUN MODE - No changes will be made\n")
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
            "metadata",
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
        attributeValuesLinked: 0,
        variantKeysMarked: 0,
        errors: [],
    }

    for (const product of multiVariantProducts) {
        console.log(`\n${"=".repeat(70)}`)
        console.log(`📦 Processing: ${product.title}`)
        console.log(`   ID: ${product.id}`)

        if (!product.options || product.options.length === 0) {
            console.log(`   ⏭️  SKIP: No product options defined`)
            continue
        }

        try {
            const attributeValuesToLink = new Set<string>()
            const variantKeyIds = new Set<string>()

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

                console.log(`      ✅ Matched to Attribute: "${matchingAttrKey.label}" (${matchingAttrKey.id})`)

                // Collect all unique variant option values for this option
                const variantValues = new Set<string>()
                for (const variant of product.variants) {
                    const variantOption = variant.options?.find(vo => vo.option_id === option.id)
                    if (variantOption?.value) {
                        variantValues.add(variantOption.value.trim())
                    }
                }

                console.log(`      📊 Variant Values: ${Array.from(variantValues).join(", ")}`)

                // Find matching attribute_values
                const matchedAttributeValues: string[] = []
                for (const variantValue of variantValues) {
                    const matchingAttrValue = matchingAttrKey.values?.find(val =>
                        val?.value?.trim().toLowerCase() === variantValue.toLowerCase()
                    )

                    if (matchingAttrValue) {
                        attributeValuesToLink.add(matchingAttrValue.id)
                        matchedAttributeValues.push(matchingAttrValue.value as string)
                    }
                }

                if (matchedAttributeValues.length > 0) {
                    console.log(`      ✅ Matched Attribute Values: ${matchedAttributeValues.join(", ")}`)
                    variantKeyIds.add(matchingAttrKey.id)
                } else {
                    console.log(`      ⚠️  No matching attribute values found`)
                }
            }

            if (attributeValuesToLink.size === 0) {
                console.log(`\n   ℹ️  No attribute values to link`)
                continue
            }

            console.log(`\n   📝 Summary:`)
            console.log(`      - Attribute Values to Link: ${attributeValuesToLink.size}`)
            console.log(`      - Variant Keys to Mark: ${variantKeyIds.size}`)

            if (!DRY_RUN) {
                // Execute the workflow using container resolver
                const workflows = container.resolve("workflows") as any
                const workflow = workflows.updateProductAttributesWorkflow

                await workflow.run({
                    input: {
                        productId: product.id,
                        valueIds: Array.from(attributeValuesToLink),
                        variantKeys: Array.from(variantKeyIds)
                    }
                })

                result.attributeValuesLinked += attributeValuesToLink.size
                result.variantKeysMarked += variantKeyIds.size
                console.log(`      ✅ Linked and marked successfully`)
            } else {
                console.log(`      [DRY-RUN] Would link ${attributeValuesToLink.size} values and mark ${variantKeyIds.size} keys`)
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
    console.log(`Attribute Values Linked: ${result.attributeValuesLinked}`)
    console.log(`Variant Keys Marked: ${result.variantKeysMarked}`)
    console.log(`Errors: ${result.errors.length}`)

    if (result.errors.length > 0) {
        console.log(`\n❌ ERRORS:`)
        for (const error of result.errors) {
            console.log(`   ${error.productId}: ${error.error}`)
        }
    }

    // Save report
    const fs = await import("fs/promises")
    const reportPath = "./product-attribute-linking-report.json"
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2))
    console.log(`\n💾 Report saved to: ${reportPath}`)

    return result
}
