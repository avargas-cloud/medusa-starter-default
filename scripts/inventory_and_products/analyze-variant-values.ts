import { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

/**
 * Analyze Variant Values in Multi-Variant Products
 * 
 * For products with orphaned variants, analyze:
 * - What values are in variant titles
 * - What's in the SKUs
 * - What options exist (if any)
 * - Find patterns for linking
 */

export default async function analyzeVariantValues({ container }: { container: MedusaContainer }) {
    console.log("🔍 Analyzing Variant Values in Multi-Variant Products...\n")

    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // Get products with multiple variants
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

    // Filter to multi-variant products
    const multiVariantProducts = products.filter(p => p.variants?.length > 1)

    console.log(`📦 Analyzing ${multiVariantProducts.length} Multi-Variant Products\n`)

    for (const product of multiVariantProducts) {
        console.log("=".repeat(70))
        console.log(`📦 ${product.title}`)
        console.log(`   ID: ${product.id}`)
        console.log(`   Handle: ${product.handle}`)
        console.log(`   Total Variants: ${product.variants.length}\n`)

        // Analyze product options
        console.log(`   🎛️  PRODUCT OPTIONS (${product.options?.length || 0}):`)
        if (product.options && product.options.length > 0) {
            for (const option of product.options) {
                console.log(`      - ${option.title}`)
                console.log(`        ID: ${option.id}`)
                console.log(`        Values: ${option.values?.length || 0}`)
                if (option.values && option.values.length > 0) {
                    for (const value of option.values) {
                        console.log(`           * ${value.value}`)
                    }
                }
            }
        } else {
            console.log(`      ❌ No product options defined`)
        }

        console.log(`\n   🏷️  VARIANTS:`)
        for (const variant of product.variants) {
            console.log(`\n      Variant: ${variant.title}`)
            console.log(`         ID: ${variant.id}`)
            console.log(`         SKU: ${variant.sku || "N/A"}`)
            console.log(`         Options: ${variant.options?.length || 0}`)

            if (variant.options && variant.options.length > 0) {
                console.log(`         Option Values:`)
                for (const opt of variant.options) {
                    console.log(`            - ${opt.value} (Option ID: ${opt.option_id})`)
                }
            } else {
                console.log(`         ❌ No options linked`)
            }
        }

        console.log("")
    }

    console.log("=".repeat(70))
    console.log("\n✅ Analysis Complete\n")

    // Now analyze patterns
    console.log("📊 PATTERN ANALYSIS")
    console.log("=".repeat(70))

    const patternsFound: any = {
        variantTitlePatterns: new Set(),
        skuPatterns: new Set(),
        commonWords: new Map(),
    }

    for (const product of multiVariantProducts) {
        for (const variant of product.variants) {
            // Collect variant titles
            if (variant.title) {
                patternsFound.variantTitlePatterns.add(variant.title)

                // Extract common words (likely attributes)
                const words = variant.title.split(/[\s,\-_]+/)
                for (const word of words) {
                    if (word.length > 1) {
                        const count = patternsFound.commonWords.get(word) || 0
                        patternsFound.commonWords.set(word, count + 1)
                    }
                }
            }

            // Collect SKU patterns
            if (variant.sku) {
                patternsFound.skuPatterns.add(variant.sku)
            }
        }
    }

    console.log(`\n🔤 Common Words in Variant Titles (Top 20):`)
    const sortedWords = Array.from(patternsFound.commonWords.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)

    for (const [word, count] of sortedWords) {
        console.log(`   "${word}" - appears ${count} times`)
    }

    console.log(`\n📝 Total Unique Variant Titles: ${patternsFound.variantTitlePatterns.size}`)
    console.log(`📝 Total Unique SKUs: ${patternsFound.skuPatterns.size}`)

    return {
        multiVariantProducts,
        patterns: {
            variantTitles: Array.from(patternsFound.variantTitlePatterns),
            skus: Array.from(patternsFound.skuPatterns),
            commonWords: Object.fromEntries(sortedWords),
        }
    }
}
