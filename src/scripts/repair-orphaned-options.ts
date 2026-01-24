import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Repair Orphaned Options - Link variants to existing options
 * 
 * For products that have "Title" option created but variant not linked
 */
export default async function repairOrphanedOptions({ container }: ExecArgs) {
    const productService = container.resolve(Modules.PRODUCT)
    const query = container.resolve("query")
    const logger = container.resolve("logger")

    logger.info("🔧 Repairing orphaned product options...")
    logger.info("=".repeat(80))

    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "options.id",
            "options.title",
            "options.values.value",
            "variants.id",
            "variants.title",
            "variants.options.option_id",
            "variants.deleted_at"
        ],
        filters: { deleted_at: null }
    })

    const orphaned = products.filter((p: any) => {
        const activeVariants = p.variants?.filter((v: any) => !v.deleted_at) || []
        const options = p.options || []

        if (activeVariants.length !== 1 || options.length === 0) return false

        const variant = activeVariants[0]
        const variantOptions = variant.options || []

        return variantOptions.length === 0
    })

    logger.info(`📊 Found ${orphaned.length} products to repair\n`)

    let stats = {
        processed: 0,
        success: 0,
        errors: [] as string[]
    }

    for (const product of orphaned) {
        stats.processed++
        const variant = product.variants[0]
        const variantTitle = variant.title || "Default"
        const titleOption = product.options.find((o: any) => o.title === "Title")

        try {
            logger.info(`\n${stats.processed}/${orphaned.length}. Processing: ${product.title}`)
            logger.info(`   Product ID: ${product.id}`)
            logger.info(`   Variant: ${variantTitle} (${variant.id})`)

            if (!titleOption) {
                logger.error(`   ❌ No "Title" option found, skipping`)
                stats.errors.push(`${product.title}: No Title option found`)
                continue
            }

            logger.info(`   Existing Option: "${titleOption.title}" (${titleOption.id})`)

            // Link variant to existing option
            logger.info(`   Linking variant to existing option...`)
            await productService.updateProductVariants(variant.id, {
                options: {
                    "Title": variantTitle
                }
            })

            logger.info(`   ✅ Variant linked successfully`)
            stats.success++

        } catch (error: any) {
            logger.error(`   ❌ Error: ${error.message}`)
            stats.errors.push(`${product.title}: ${error.message}`)
        }
    }

    logger.info("\n" + "=".repeat(80))
    logger.info("📊 REPAIR SUMMARY")
    logger.info("=".repeat(80))
    logger.info(`Total products processed: ${stats.processed}`)
    logger.info(`Successfully repaired: ${stats.success}`)
    logger.info(`Errors: ${stats.errors.length}`)

    if (stats.errors.length > 0) {
        logger.error(`\n❌ Errors encountered:`)
        stats.errors.forEach(err => logger.error(`  - ${err}`))
    }

    logger.info("\n✅ Repair completed!")
}
