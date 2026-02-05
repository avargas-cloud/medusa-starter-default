import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Fix Single Product Options - Medusa v2 Exec Pattern
 * 
 * Creates "Title" Product Option for single variant products
 * and links the existing variant to that option
 * 
 * Usage: 
 *   medusa exec ./src/scripts/fix-single-product-options.ts [--live] [--limit=N]
 * 
 * Flags:
 *   --live       Execute changes (default: dry-run)
 *   --limit=N    Process only first N products (for testing)
 */
export default async function fixSingleProductOptions(
    { container }: ExecArgs,
    args: string[] = []
) {
    const productService = container.resolve(Modules.PRODUCT)
    const query = container.resolve("query")
    const logger = container.resolve("logger")

    // Force LIVE mode for full migration
    const dryRun = false

    // No limit - process all products
    const limit = null

    logger.info("🔧 Starting single product options fix...")
    logger.info(`Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (will update)"}`)
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
                "options.title",
                "variants.id",
                "variants.title",
                "variants.deleted_at"
            ],
            filters: {
                deleted_at: null
            }
        })

        // Filter in memory: 1 variant, 0 options, variant not deleted
        const affectedProducts = products.filter((p: any) => {
            const activeVariants = p.variants?.filter((v: any) => !v.deleted_at) || []
            const activeOptions = p.options || []

            return activeVariants.length === 1 && activeOptions.length === 0
        })

        logger.info(`📊 Found ${affectedProducts.length} products to fix`)

        // Apply limit if specified
        const productsToProcess = limit ? affectedProducts.slice(0, limit) : affectedProducts

        if (limit && productsToProcess.length < affectedProducts.length) {
            logger.info(`   Processing only first ${limit} products for testing\n`)
        } else {
            logger.info("")
        }

        if (productsToProcess.length === 0) {
            logger.info("✅ No products need fixing!")
            return
        }

        let stats = {
            processed: 0,
            success: 0,
            skipped: 0,
            errors: [] as string[]
        }

        for (const product of productsToProcess) {
            stats.processed++
            const variant = product.variants[0]
            const variantTitle = variant.title || "Default Variant"

            try {
                logger.info(`\n${stats.processed}/${affectedProducts.length}. Processing: ${product.title}`)
                logger.info(`   Product ID: ${product.id}`)
                logger.info(`   Variant: ${variantTitle} (${variant.id})`)

                // IDEMPOTENCY CHECK: Verify if option already exists
                const existingProduct = await productService.retrieveProduct(product.id, {
                    relations: ["options"]
                })

                const titleOptionExists = existingProduct.options?.some(
                    (opt: any) => opt.title === "Title"
                )

                if (titleOptionExists) {
                    logger.info(`   ⏭️  SKIP: Option "Title" already exists`)
                    stats.skipped++
                    continue
                }

                if (!dryRun) {
                    // Step A) Create Product Option "Title" with value "Default Variant"
                    // This automatically creates the ProductOptionValue record
                    logger.info(`   Creating option "Title"...`)
                    const createdOptions = await productService.createProductOptions([{
                        title: "Title",
                        product_id: product.id,
                        values: [variantTitle] // CRITICAL: creates the option value
                    }])

                    const option = createdOptions[0]
                    logger.info(`   ✅ Option created: ${option.id}`)

                    // Step B) Update variant to link to the option
                    // Medusa v2 signature: updateProductVariants(variantId, updateObject)
                    logger.info(`   Linking variant to option...`)
                    await productService.updateProductVariants(variant.id, {
                        options: {
                            "Title": variantTitle
                        }
                    })

                    logger.info(`   ✅ Variant linked successfully`)
                } else {
                    logger.info(`   [DRY RUN] Would create option "Title" with value "${variantTitle}"`)
                    logger.info(`   [DRY RUN] Would link variant ${variant.id} to option`)
                }

                stats.success++

            } catch (error: any) {
                logger.error(`   ❌ Error: ${error.message}`)
                stats.errors.push(`${product.title}: ${error.message}`)
            }
        }

        // Print summary
        logger.info("\n" + "=".repeat(80))
        logger.info("📊 FIX SUMMARY")
        logger.info("=".repeat(80))
        logger.info(`Total products processed: ${stats.processed}`)
        logger.info(`Successfully ${dryRun ? "would be" : ""} updated: ${stats.success}`)
        logger.info(`Skipped (already fixed): ${stats.skipped}`)
        logger.info(`Errors: ${stats.errors.length}`)

        if (stats.errors.length > 0) {
            logger.error(`\n❌ Errors encountered:`)
            stats.errors.slice(0, 10).forEach(err => logger.error(`  - ${err}`))
            if (stats.errors.length > 10) {
                logger.error(`  ... and ${stats.errors.length - 10} more errors`)
            }
        }

        logger.info("\n" + "=".repeat(80))

        if (dryRun) {
            logger.info("\n💡 This was a DRY RUN - no changes were made")
            logger.info("   Run with --live to execute the migration:")
            logger.info("   medusa exec ./src/scripts/fix-single-product-options.ts --live")
            if (limit) {
                logger.info(`\n   Note: This test processed only ${limit} products.`)
                logger.info(`   Remove --limit flag to process all ${affectedProducts.length} products.`)
            }
        } else {
            logger.info("\n✅ Migration completed!")
            if (limit) {
                logger.info(`   Updated ${stats.success} of ${affectedProducts.length} total products`)
            } else {
                logger.info("   All single variant products now have Product Options")
            }
        }

    } catch (error: any) {
        logger.error("❌ Migration failed:", error)
        throw error
    }
}
