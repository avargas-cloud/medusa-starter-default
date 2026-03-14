import { ExecArgs } from "@medusajs/framework/types"
import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"

/**
 * Bulk cleanup of duplicate default retail prices.
 * 
 * Strategy: for each variant with >1 default retail price, keep the OLDEST 
 * one (lowest ULID = created earliest) and delete all newer duplicates.
 * The oldest price is the correct one set during initial product creation.
 * The duplicates are garbage created by the old sync bug that used updatePriceSets
 * which added new prices instead of updating existing ones.
 */
export default async function ({ container }: ExecArgs) {
    const pricingModule = container.resolve(Modules.PRICING) as any
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("🧹 Starting bulk duplicate retail price cleanup...")

    const { data: variants } = await query.graph({
        entity: "variant",
        fields: ["id", "sku", "price_set.id", "price_set.prices.*"]
    })

    let totalVariants = 0
    let cleanedVariants = 0
    let deletedPrices = 0

    for (const v of variants) {
        totalVariants++
        if (!v.price_set?.prices) continue

        // Find all default retail prices (no price list = no wholesale/special pricing)
        const retailPrices = (v.price_set.prices as any[]).filter((p: any) => !p.price_list_id)
        if (retailPrices.length <= 1) continue

        // Sort by ID (ULID) ascending — oldest first = correct one
        retailPrices.sort((a: any, b: any) => a.id.localeCompare(b.id))

        const correct = retailPrices[0]
        const toDelete = retailPrices.slice(1).map((p: any) => p.id)

        logger.warn(`  🧹 ${v.sku || v.id}: keeping $${(+correct.amount).toFixed(2)}, deleting ${toDelete.length} duplicate(s) [$${retailPrices.slice(1).map((p: any) => (+p.amount).toFixed(2)).join(', $')}]`)

        try {
            await pricingModule.deletePrices(toDelete)
            cleanedVariants++
            deletedPrices += toDelete.length
        } catch (e: any) {
            logger.error(`  ❌ Failed for ${v.sku}: ${e.message}`)
        }
    }

    logger.info(`\n${"=".repeat(50)}`)
    logger.info(`✅ CLEANUP COMPLETE`)
    logger.info(`${"=".repeat(50)}`)
    logger.info(`Total variants scanned: ${totalVariants}`)
    logger.info(`Variants cleaned: ${cleanedVariants}`)
    logger.info(`Duplicate prices deleted: ${deletedPrices}`)
    logger.info(`${"=".repeat(50)}\n`)
}
