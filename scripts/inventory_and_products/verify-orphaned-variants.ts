import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

/**
 * Verify Orphaned Variants
 * 
 * Audits all multi-variant products to identify:
 * 1. Variants without any option links
 * 2. Variants with mismatched option values
 * 3. Products with incomplete option_value coverage
 */

interface OrphanedVariant {
    productId: string
    productTitle: string
    productHandle: string
    variantId: string
    variantTitle: string
    variantSku: string
    issue: string
    optionTitle?: string
    expectedValue?: string
    actualValue?: string
}

interface AuditReport {
    totalProducts: number
    totalVariants: number
    orphanedVariants: OrphanedVariant[]
    productsWithIssues: number
    summary: {
        variantsWithNoOptions: number
        variantsWithMismatchedOptions: number
        variantsWithEmptyOptionValues: number
    }
}

export default async function verifyOrphanedVariants({ container }: { container: MedusaContainer }) {
    console.log("🔍 Auditing Multi-Variant Products for Orphaned Variants...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Get all multi-variant products with full option data
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

    console.log(`📦 Found ${multiVariantProducts.length} multi-variant products`)
    console.log(`📊 Total variants to audit: ${multiVariantProducts.reduce((sum, p) => sum + p.variants.length, 0)}\n`)

    const report: AuditReport = {
        totalProducts: multiVariantProducts.length,
        totalVariants: 0,
        orphanedVariants: [],
        productsWithIssues: 0,
        summary: {
            variantsWithNoOptions: 0,
            variantsWithMismatchedOptions: 0,
            variantsWithEmptyOptionValues: 0,
        }
    }

    const productsWithIssuesSet = new Set<string>()

    for (const product of multiVariantProducts) {
        if (!product.options || product.options.length === 0) {
            // Product has no options defined - skip
            continue
        }

        let productHasIssues = false

        for (const variant of product.variants) {
            report.totalVariants++
            const variantTitle = variant.title?.trim()

            // ISSUE 1: Variant has no options linked at all
            if (!variant.options || variant.options.length === 0) {
                report.orphanedVariants.push({
                    productId: product.id,
                    productTitle: product.title,
                    productHandle: product.handle,
                    variantId: variant.id,
                    variantTitle: variantTitle || "N/A",
                    variantSku: variant.sku || "N/A",
                    issue: "NO_OPTIONS",
                })
                report.summary.variantsWithNoOptions++
                productHasIssues = true
                continue
            }

            // Check each product option to see if variant is properly linked
            for (const productOption of product.options) {
                const variantOption = variant.options.find(vo => vo.option_id === productOption.id)

                // ISSUE 2: Variant missing this option entirely
                if (!variantOption) {
                    report.orphanedVariants.push({
                        productId: product.id,
                        productTitle: product.title,
                        productHandle: product.handle,
                        variantId: variant.id,
                        variantTitle: variantTitle || "N/A",
                        variantSku: variant.sku || "N/A",
                        issue: "MISSING_OPTION",
                        optionTitle: productOption.title,
                        expectedValue: variantTitle,
                    })
                    report.summary.variantsWithMismatchedOptions++
                    productHasIssues = true
                    continue
                }

                // ISSUE 3: Variant option has no value (empty/null)
                if (!variantOption.value || variantOption.value.trim() === "") {
                    report.orphanedVariants.push({
                        productId: product.id,
                        productTitle: product.title,
                        productHandle: product.handle,
                        variantId: variant.id,
                        variantTitle: variantTitle || "N/A",
                        variantSku: variant.sku || "N/A",
                        issue: "EMPTY_OPTION_VALUE",
                        optionTitle: productOption.title,
                        expectedValue: variantTitle,
                        actualValue: variantOption.value || "(empty)",
                    })
                    report.summary.variantsWithEmptyOptionValues++
                    productHasIssues = true
                }
            }
        }

        if (productHasIssues) {
            productsWithIssuesSet.add(product.id)
        }
    }

    report.productsWithIssues = productsWithIssuesSet.size

    // Print Results
    console.log("\n" + "=".repeat(70))
    console.log("📊 AUDIT SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Multi-Variant Products: ${report.totalProducts}`)
    console.log(`Total Variants Audited: ${report.totalVariants}`)
    console.log(`Products with Issues: ${report.productsWithIssues}`)
    console.log(`Total Orphaned Variants: ${report.orphanedVariants.length}`)
    console.log("")
    console.log("Issue Breakdown:")
    console.log(`  - Variants with NO options: ${report.summary.variantsWithNoOptions}`)
    console.log(`  - Variants with MISSING options: ${report.summary.variantsWithMismatchedOptions}`)
    console.log(`  - Variants with EMPTY option values: ${report.summary.variantsWithEmptyOptionValues}`)

    if (report.orphanedVariants.length > 0) {
        console.log("\n" + "=".repeat(70))
        console.log("❌ ORPHANED VARIANTS FOUND")
        console.log("=".repeat(70))

        // Group by product
        const byProduct = new Map<string, OrphanedVariant[]>()
        for (const orphan of report.orphanedVariants) {
            if (!byProduct.has(orphan.productId)) {
                byProduct.set(orphan.productId, [])
            }
            byProduct.get(orphan.productId)!.push(orphan)
        }

        for (const [productId, orphans] of byProduct) {
            const first = orphans[0]
            console.log(`\n📦 ${first.productTitle}`)
            console.log(`   Handle: ${first.productHandle}`)
            console.log(`   ID: ${productId}`)
            console.log(`   Orphaned Variants: ${orphans.length}`)

            for (const orphan of orphans) {
                console.log(`\n   🚨 Variant: "${orphan.variantTitle}" (SKU: ${orphan.variantSku})`)
                console.log(`      ID: ${orphan.variantId}`)

                if (orphan.issue === "NO_OPTIONS") {
                    console.log(`      Issue: ❌ No options linked`)
                } else if (orphan.issue === "MISSING_OPTION") {
                    console.log(`      Issue: ❌ Missing option "${orphan.optionTitle}"`)
                    console.log(`      Expected: "${orphan.expectedValue}"`)
                } else if (orphan.issue === "EMPTY_OPTION_VALUE") {
                    console.log(`      Issue: ❌ Empty value for option "${orphan.optionTitle}"`)
                    console.log(`      Expected: "${orphan.expectedValue}"`)
                    console.log(`      Actual: ${orphan.actualValue}`)
                }
            }
        }
    } else {
        console.log("\n✅ No orphaned variants found! All variants are properly linked.")
    }

    // Save detailed report
    const fs = await import("fs/promises")
    const reportPath = "./orphaned-variants-audit.json"
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    console.log(`\n💾 Detailed report saved to: ${reportPath}`)

    return report
}
