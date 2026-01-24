import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Deep Analysis: Match Product Options with Existing Attributes
 * 
 * For each multi-variant product:
 * 1. Read product option title (e.g., "Color Options")
 * 2. Search if ProductAttribute exists with matching name
 * 3. Compare variant.title with ProductAttributeValue
 * 4. Determine if we can link or need to recreate
 */

interface MatchResult {
    productId: string
    productTitle: string
    productOption: {
        id: string
        title: string
    }
    attributeMatch: {
        found: boolean
        attributeId?: string
        attributeTitle?: string
        attributeHandle?: string
    }
    variants: Array<{
        id: string
        title: string
        sku: string | null
        valueMatch: {
            found: boolean
            valueId?: string
            valueLabel?: string
            exactMatch: boolean
        }
    }>
    canAutoLink: boolean
    needsManualReview: boolean
}

export default async function matchOptionsWithAttributes({ container }: { container: MedusaContainer }) {
    console.log("🔍 Deep Analysis: Matching Product Options with Attributes...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Get all product attributes with their values
    const { data: attributes } = await query.graph({
        entity: "attribute_key",
        fields: [
            "id",
            "title",
            "label",
            "handle",
            "values.*",
        ],
    })

    console.log(`📚 Loaded ${attributes.length} Product Attributes\n`)

    // Get multi-variant products
    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "handle",
            "variants.*",
            "options.*",
        ],
    })

    const multiVariantProducts = products.filter(p => p.variants?.length > 1)
    console.log(`📦 Analyzing ${multiVariantProducts.length} Multi-Variant Products\n`)

    const results: MatchResult[] = []
    let canAutoLink = 0
    let needsReview = 0
    let noAttributeMatch = 0

    for (const product of multiVariantProducts) {
        if (!product.options || product.options.length === 0) {
            continue
        }

        // For each product option (usually just 1 for these products)
        for (const option of product.options) {
            const optionTitle = option.title.toLowerCase().trim()

            // Find matching attribute
            const matchingAttribute = attributes.find(attr => {
                const attrTitle = attr.title?.toLowerCase().trim()
                const attrLabel = attr.label?.toLowerCase().trim()

                return attrTitle === optionTitle ||
                    attrLabel === optionTitle ||
                    attrTitle?.includes(optionTitle) ||
                    optionTitle.includes(attrTitle || '')
            })

            const result: MatchResult = {
                productId: product.id,
                productTitle: product.title,
                productOption: {
                    id: option.id,
                    title: option.title,
                },
                attributeMatch: {
                    found: !!matchingAttribute,
                    attributeId: matchingAttribute?.id,
                    attributeTitle: matchingAttribute?.title,
                    attributeHandle: matchingAttribute?.handle,
                },
                variants: [],
                canAutoLink: false,
                needsManualReview: false,
            }

            if (!matchingAttribute) {
                noAttributeMatch++
                result.needsManualReview = true
                results.push(result)
                continue
            }

            // Check each variant against attribute values
            let allVariantsMatch = true

            for (const variant of product.variants) {
                const variantTitle = variant.title?.toLowerCase().trim()

                // Find matching value in attribute
                const matchingValue = matchingAttribute.values?.find(val => {
                    const valLabel = val.label?.toLowerCase().trim()
                    const valValue = val.value?.toLowerCase().trim()

                    return valLabel === variantTitle ||
                        valValue === variantTitle ||
                        valLabel?.includes(variantTitle || '') ||
                        variantTitle?.includes(valLabel || '')
                })

                result.variants.push({
                    id: variant.id,
                    title: variant.title,
                    sku: variant.sku,
                    valueMatch: {
                        found: !!matchingValue,
                        valueId: matchingValue?.id,
                        valueLabel: matchingValue?.label,
                        exactMatch: matchingValue?.label?.toLowerCase() === variantTitle,
                    }
                })

                if (!matchingValue) {
                    allVariantsMatch = false
                }
            }

            result.canAutoLink = allVariantsMatch && result.variants.length > 0
            result.needsManualReview = !allVariantsMatch

            if (result.canAutoLink) {
                canAutoLink++
            } else {
                needsReview++
            }

            results.push(result)
        }
    }

    // Print Summary
    console.log("📊 MATCHING SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Products Analyzed: ${multiVariantProducts.length}`)
    console.log(`✅ Can Auto-Link: ${canAutoLink}`)
    console.log(`⚠️  Need Manual Review: ${needsReview}`)
    console.log(`❌ No Attribute Match: ${noAttributeMatch}\n`)

    // Print Detailed Report
    console.log("✅ PRODUCTS READY FOR AUTO-LINKING")
    console.log("=".repeat(70))

    for (const result of results.filter(r => r.canAutoLink)) {
        console.log(`\n📦 ${result.productTitle}`)
        console.log(`   Product ID: ${result.productId}`)
        console.log(`   Option: "${result.productOption.title}" → Attribute: "${result.attributeMatch.attributeTitle}"`)
        console.log(`   Variants (${result.variants.length}):`)

        for (const variant of result.variants) {
            console.log(`      "${variant.title}" → "${variant.valueMatch.valueLabel}" ✓`)
            console.log(`         SKU: ${variant.sku || 'N/A'}`)
        }
    }

    console.log("\n\n⚠️  PRODUCTS NEEDING MANUAL REVIEW")
    console.log("=".repeat(70))

    for (const result of results.filter(r => r.needsManualReview)) {
        console.log(`\n📦 ${result.productTitle}`)
        console.log(`   Product ID: ${result.productId}`)
        console.log(`   Option: "${result.productOption.title}"`)

        if (result.attributeMatch.found) {
            console.log(`   ✓ Attribute Found: "${result.attributeMatch.attributeTitle}"`)
            console.log(`   ❌ But some variants don't match:`)

            for (const variant of result.variants) {
                if (!variant.valueMatch.found) {
                    console.log(`      "${variant.title}" - NO MATCH FOUND`)
                    console.log(`         SKU: ${variant.sku || 'N/A'}`)
                }
            }
        } else {
            console.log(`   ❌ No matching attribute found for option "${result.productOption.title}"`)
        }
    }

    // Save detailed JSON report
    const fs = await import("fs/promises")
    const reportPath = "./attribute-matching-report.json"
    await fs.writeFile(reportPath, JSON.stringify(results, null, 2))
    console.log(`\n\n💾 Detailed report saved to: ${reportPath}`)

    return {
        summary: {
            total: multiVariantProducts.length,
            canAutoLink,
            needsReview,
            noAttributeMatch,
        },
        results,
    }
}
