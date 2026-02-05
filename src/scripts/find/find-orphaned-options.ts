import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Find products with options but unlinked variants
 * (from failed executions that created options but didn't link variants)
 */
export default async function findOrphanedOptions({ container }: ExecArgs) {
    const query = container.resolve("query")
    const logger = container.resolve("logger")

    logger.info("🔍 Finding products with options but unlinked variants...\n")

    const { data: products } = await query.graph({
        entity: "product",
        fields: [
            "id",
            "title",
            "options.id",
            "options.title",
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

        // Has exactly 1 variant and at least 1 option
        if (activeVariants.length !== 1 || options.length === 0) return false

        const variant = activeVariants[0]
        const variantOptions = variant.options || []

        // Variant has NO linked options
        return variantOptions.length === 0
    })

    logger.info(`Found ${orphaned.length} products with orphaned options:\n`)

    orphaned.forEach((p: any, idx: number) => {
        logger.info(`${idx + 1}. ${p.title}`)
        logger.info(`   Product ID: ${p.id}`)
        logger.info(`   Options: ${p.options.map((o: any) => o.title).join(", ")}`)
        logger.info(`   Variant ID: ${p.variants[0].id}`)
        logger.info(`   Variant has ${p.variants[0].options?.length || 0} linked options\n`)
    })

    return orphaned.map((p: any) => p.id)
}
