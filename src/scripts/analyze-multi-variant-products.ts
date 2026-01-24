import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Analyze Multi-Variant Products
 * 
 * Identifies products with multiple variants and checks:
 * 1. How many variants each product has
 * 2. Which variants have SKUs
 * 3. Which variants have proper option associations
 * 4. Which variants are "orphaned" (no options linked)
 */

interface AnalysisResult {
    totalProducts: number
    singleVariantProducts: number
    multiVariantProducts: number
    productsWithOrphanedVariants: {
        productId: string
        title: string
        totalVariants: number
        variantsWithSKU: number
        variantsWithoutOptions: number
        orphanedVariants: Array<{
            id: string
            sku: string | null
            title: string
            hasOptions: boolean
            optionCount: number
        }>
    }[]
}

export default async function analyzeMultiVariantProducts({ container }: { container: MedusaContainer }) {
    console.log("🔍 Analyzing Multi-Variant Products...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Get all products with their variants and options
    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "handle",
            "variants.*",
            "variants.options.*",
            "options.*",
        ],
    })

    const analysis: AnalysisResult = {
        totalProducts: products.length,
        singleVariantProducts: 0,
        multiVariantProducts: 0,
        productsWithOrphanedVariants: [],
    }

    console.log(`📦 Total Products: ${products.length}\n`)

    for (const product of products) {
        const variantCount = product.variants?.length || 0

        if (variantCount === 1) {
            analysis.singleVariantProducts++
            continue
        }

        if (variantCount > 1) {
            analysis.multiVariantProducts++

            // Analyze each variant
            const orphanedVariants: any[] = []
            let variantsWithSKU = 0

            for (const variant of product.variants || []) {
                if (variant.sku) {
                    variantsWithSKU++
                }

                const optionCount = variant.options?.length || 0
                const hasOptions = optionCount > 0

                if (!hasOptions) {
                    orphanedVariants.push({
                        id: variant.id,
                        sku: variant.sku,
                        title: variant.title,
                        hasOptions: false,
                        optionCount: 0,
                    })
                }
            }

            // If there are orphaned variants, add to report
            if (orphanedVariants.length > 0) {
                analysis.productsWithOrphanedVariants.push({
                    productId: product.id,
                    title: product.title,
                    totalVariants: variantCount,
                    variantsWithSKU: variantsWithSKU,
                    variantsWithoutOptions: orphanedVariants.length,
                    orphanedVariants: orphanedVariants,
                })
            }
        }
    }

    // Print Summary
    console.log("📊 SUMMARY")
    console.log("=".repeat(60))
    console.log(`Total Products: ${analysis.totalProducts}`)
    console.log(`Single-Variant Products: ${analysis.singleVariantProducts}`)
    console.log(`Multi-Variant Products: ${analysis.multiVariantProducts}`)
    console.log(`Products with Orphaned Variants: ${analysis.productsWithOrphanedVariants.length}\n`)

    // Print Detailed Report
    if (analysis.productsWithOrphanedVariants.length > 0) {
        console.log("🚨 PRODUCTS WITH ORPHANED VARIANTS")
        console.log("=".repeat(60))

        for (const product of analysis.productsWithOrphanedVariants) {
            console.log(`\n📦 ${product.title}`)
            console.log(`   ID: ${product.productId}`)
            console.log(`   Total Variants: ${product.totalVariants}`)
            console.log(`   Variants with SKU: ${product.variantsWithSKU}`)
            console.log(`   Orphaned Variants: ${product.variantsWithoutOptions}\n`)

            for (const variant of product.orphanedVariants) {
                console.log(`   ❌ Variant: ${variant.title || "Untitled"}`)
                console.log(`      ID: ${variant.id}`)
                console.log(`      SKU: ${variant.sku || "N/A"}`)
                console.log(`      Options: ${variant.optionCount}`)
            }
        }

        console.log("\n" + "=".repeat(60))
    } else {
        console.log("✅ No orphaned variants found! All multi-variant products have proper options.\n")
    }

    // Save detailed JSON report
    const fs = await import("fs/promises")
    const reportPath = "./orphaned-variants-report.json"
    await fs.writeFile(reportPath, JSON.stringify(analysis, null, 2))
    console.log(`\n💾 Detailed report saved to: ${reportPath}`)

    return analysis
}
