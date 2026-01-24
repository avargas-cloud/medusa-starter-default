import { ExecArgs } from "@medusajs/framework/types"

/**
 * Diagnostic Script: Single Product Options Issue
 * 
 * Usage: medusa exec ./src/scripts/diagnose-single-products.ts
 */
export default async function diagnoseSingleProducts({ container }: ExecArgs) {
    const query = container.resolve("query")
    const logger = container.resolve("logger")

    logger.info("🔍 Diagnosing single variant products without options...")
    logger.info("=".repeat(80))

    try {
        // Use Remote Query for powerful filtering
        const { data: products } = await query.graph({
            entity: "product",
            fields: [
                "id",
                "title",
                "handle",
                "metadata",
                "options.id",
                "variants.id",
                "variants.title",
                "variants.sku",
                "variants.deleted_at"
            ],
            filters: {
                deleted_at: null
            }
        })

        // Filter in memory
        const affectedProducts = products.filter((p: any) => {
            const activeVariants = p.variants?.filter((v: any) => !v.deleted_at) || []
            const activeOptions = p.options || []

            return activeVariants.length === 1 && activeOptions.length === 0
        })

        logger.info(`\n📊 DIAGNOSIS RESULTS`)
        logger.info("=".repeat(80))
        logger.info(`Total products with 1 variant and NO options: ${affectedProducts.length}`)

        if (affectedProducts.length === 0) {
            logger.info("\n✅ No products need fixing - all single variant products have options!")
            return
        }

        logger.info(`\n📋 Sample affected products (first 10):`)
        logger.info("=".repeat(80))

        affectedProducts.slice(0, 10).forEach((product: any, idx: number) => {
            const variant = product.variants[0]
            logger.info(`\n${idx + 1}. ${product.title}`)
            logger.info(`   ID: ${product.id}`)
            logger.info(`   Handle: ${product.handle}`)
            logger.info(`   Variant: ${variant.title || 'Untitled'}`)
            logger.info(`   SKU: ${variant.sku || 'No SKU'}`)
            logger.info(`   WC Type: ${product.metadata?.wc_type || 'N/A'}`)
        })

        if (affectedProducts.length > 10) {
            logger.info(`\n   ... and ${affectedProducts.length - 10} more products`)
        }

        // Categorize by WC type
        const byType = affectedProducts.reduce((acc: any, p: any) => {
            const type = p.metadata?.wc_type || 'unknown'
            acc[type] = (acc[type] || 0) + 1
            return acc
        }, {})

        logger.info(`\n📈 Breakdown by WooCommerce type:`)
        logger.info("=".repeat(80))
        Object.entries(byType).forEach(([type, count]) => {
            logger.info(`  ${type}: ${count} products`)
        })

        logger.info("\n" + "=".repeat(80))
        logger.info("💡 NEXT STEPS:")
        logger.info("   1. Review the sample products above")
        logger.info("   2. Run fix script with dry-run:")
        logger.info("      medusa exec ./src/scripts/fix-single-product-options.ts")
        logger.info("   3. If looks good, run in LIVE mode:")
        logger.info("      medusa exec ./src/scripts/fix-single-product-options.ts --live")
        logger.info("=".repeat(80))

    } catch (error: any) {
        logger.error("❌ Diagnosis failed:", error)
        throw error
    }
}
