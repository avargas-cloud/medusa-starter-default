import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { PRODUCT_ATTRIBUTES_MODULE } from "../modules/product-attributes"

/**
 * Link Products to Attribute Values - DIRECT VERSION
 * 
 * Uses remoteLink and productService directly to:
 * 1. Link products to attribute_values (populate "Product Attributes" widget)
 * 2. Mark attribute keys as variant-level (show "Variant" badge)
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

export default async function linkProductsToAttributeValuesDirect({ container }: { container: MedusaContainer }) {
    const DRY_RUN = false

    console.log("🔗 Linking Products to Attribute Values (DIRECT VERSION)...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productService = container.resolve(Modules.PRODUCT)
    const remoteLink = container.resolve("remoteLink")

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
            const attributeValuesToLink: string[] = []
            const variantKeyIds: string[] = []

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
                const variantValues: string[] = []
                for (const variant of product.variants) {
                    const variantOption = variant.options?.find(vo => vo.option_id === option.id)
                    if (variantOption?.value && !variantValues.includes(variantOption.value.trim())) {
                        variantValues.push(variantOption.value.trim())
                    }
                }

                console.log(`      📊 Variant Values: ${variantValues.join(", ")}`)

                // Find matching attribute_values
                const matchedAttributeValues: string[] = []
                for (const variantValue of variantValues) {
                    const matchingAttrValue = matchingAttrKey.values?.find(val =>
                        val?.value?.trim().toLowerCase() === variantValue.toLowerCase()
                    )

                    if (matchingAttrValue) {
                        attributeValuesToLink.push(matchingAttrValue.id)
                        matchedAttributeValues.push(matchingAttrValue.value)
                    }
                }

                if (matchedAttributeValues.length > 0) {
                    console.log(`      ✅ Matched Attribute Values: ${matchedAttributeValues.join(", ")}`)
                    variantKeyIds.push(matchingAttrKey.id)
                } else {
                    console.log(`      ⚠️  No matching attribute values found`)
                }
            }

            if (attributeValuesToLink.length === 0) {
                console.log(`\n   ℹ️  No attribute values to link`)
                continue
            }

            console.log(`\n   📝 Summary:`)
            console.log(`      - Attribute Values to Link: ${attributeValuesToLink.length}`)
            console.log(`      - Variant Keys to Mark: ${variantKeyIds.length}`)

            if (!DRY_RUN) {
                // 1. Link product to attribute_values using remoteLink
                const linksToCreate = attributeValuesToLink.map(valueId => ({
                    [Modules.PRODUCT]: { product_id: product.id },
                    [PRODUCT_ATTRIBUTES_MODULE]: { attribute_value_id: valueId }
                }))

                await remoteLink.create(linksToCreate)
                result.attributeValuesLinked += attributeValuesToLink.length

                // 2. Update product metadata for variant keys
                await productService.updateProducts(product.id, {
                    metadata: {
                        ...product.metadata,
                        variant_attributes: variantKeyIds
                    }
                })
                result.variantKeysMarked += variantKeyIds.length

                console.log(`      ✅ Linked ${attributeValuesToLink.length} values and marked $ {variantKeyIds.length} keys`)
            } else {
                console.log(`      [DRY-RUN] Would link ${attributeValuesToLink.length} values and mark ${variantKeyIds.length} keys`)
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
    const reportPath = "./product-attribute-linking-final-report.json"
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2))
    console.log(`\n💾 Report saved to: ${reportPath}`)

    return result
}
