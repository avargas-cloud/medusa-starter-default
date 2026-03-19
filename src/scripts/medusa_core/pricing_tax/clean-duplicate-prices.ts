/**
 * Clean Duplicate Default Prices (BATCH OPTIMIZED)
 * 
 * Problem: Multiple default prices (price_list_id = null) per variant/currency
 * Solution: Keep NEWEST default price, delete older duplicates
 * Keep ALL wholesale prices (price_list_id != null)
 */

import { Modules } from "@medusajs/utils"

const DRY_RUN = false // Set to true to preview changes

export default async function cleanDuplicatePrices({ container }: any) {
    const logger = container.resolve("logger")
    const pricingModuleService = container.resolve(Modules.PRICING)

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log("\n🧹 CLEANING DUPLICATE DEFAULT PRICES")
    log(DRY_RUN ? "🔍 DRY RUN MODE - No changes will be made\n" : "\n")

    try {
        // 1. Get all price sets with prices
        log("📊 Loading price sets...")
        const priceSets = await pricingModuleService.listPriceSets({}, {
            relations: ["prices"]
        })

        log(`   Found ${priceSets.length} price sets\n`)

        let totalDuplicates = 0
        let affectedVariants = 0
        const pricesToDelete: string[] = []

        // 2. Process each price set
        for (const priceSet of priceSets) {
            if (!priceSet.prices || priceSet.prices.length === 0) continue

            // Group prices by currency and price_list_id
            const pricesByCurrency = new Map<string, any[]>()

            priceSet.prices.forEach((price: any) => {
                const key = `${price.currency_code}::${price.price_list_id || 'default'}`
                if (!pricesByCurrency.has(key)) {
                    pricesByCurrency.set(key, [])
                }
                pricesByCurrency.get(key)!.push(price)
            })

            // 3. Find duplicates (only in DEFAULT prices)
            for (const [key, prices] of pricesByCurrency.entries()) {
                // Only check default prices
                if (!key.endsWith('::default')) continue

                if (prices.length > 1) {
                    // Sort by created_at DESC (keep newest)
                    prices.sort((a, b) => {
                        const dateA = new Date(a.created_at || 0).getTime()
                        const dateB = new Date(b.created_at || 0).getTime()
                        return dateB - dateA
                    })

                    // Keep first (newest), delete rest
                    const toKeep = prices[0]
                    const toDelete = prices.slice(1)

                    log(`   Found ${prices.length} default ${prices[0].currency_code} prices`)
                    log(`     ✅ KEEP:   $${toKeep.amount.toFixed(2)} (${toKeep.id})`)

                    toDelete.forEach((price: any) => {
                        log(`     ❌ DELETE: $${price.amount.toFixed(2)} (${price.id})`)
                        pricesToDelete.push(price.id)
                    })

                    totalDuplicates += toDelete.length
                    affectedVariants++
                }
            }
        }

        log(`\n${"=".repeat(70)}`)
        log("📊 ANALYSIS COMPLETE")
        log("=".repeat(70))
        log(`Variants with duplicates: ${affectedVariants}`)
        log(`Duplicate prices to delete: ${totalDuplicates}`)
        log("=".repeat(70))

        if (pricesToDelete.length === 0) {
            log("\n✅ No duplicate prices found!")
            return { success: true, deleted: 0 }
        }

        if (DRY_RUN) {
            log("\n🔍 DRY RUN - Set DRY_RUN=false to apply changes")
            return { success: true, deleted: 0, dryRun: true }
        }

        // 4. Delete duplicates in batches
        log("\n🗑️  Deleting duplicate prices...")

        const batchSize = 100
        let deleted = 0

        for (let i = 0; i < pricesToDelete.length; i += batchSize) {
            const batch = pricesToDelete.slice(i, i + batchSize)

            await pricingModuleService.deletePrices(batch)
            deleted += batch.length

            if (deleted % 100 === 0 || deleted === pricesToDelete.length) {
                log(`   ✓ Deleted ${deleted}/${pricesToDelete.length} prices...`)
            }
        }

        log(`\n${"=".repeat(70)}`)
        log("✅ CLEANUP COMPLETE!")
        log("=".repeat(70))
        log(`🗑️  Deleted: ${deleted} duplicate prices`)
        log(`✅ Fixed: ${affectedVariants} variants`)
        log("=".repeat(70))
        log("\n📝 Next: Re-run verify script to confirm cleanup")

        return {
            success: true,
            deleted,
            affectedVariants
        }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        throw error
    }
}
