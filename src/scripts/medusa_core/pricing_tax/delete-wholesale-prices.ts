/**
 * Delete All Wholesale Prices
 * Removes all prices with price_list_id (keeps only default prices)
 */

import { Modules } from "@medusajs/utils"

export default async function deleteWholesalePrices({ container }: any) {
    const logger = container.resolve("logger")
    const pricingModuleService = container.resolve(Modules.PRICING)

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log("\n🗑️  DELETING ALL WHOLESALE PRICES\n")

    try {
        // Get all price sets with wholesale prices
        const priceSets = await pricingModuleService.listPriceSets({}, {
            relations: ["prices"]
        })

        const wholesalePriceIds: string[] = []

        priceSets.forEach((priceSet: any) => {
            if (!priceSet.prices) return

            priceSet.prices.forEach((price: any) => {
                if (price.price_list_id) {
                    wholesalePriceIds.push(price.id)
                }
            })
        })

        log(`Found ${wholesalePriceIds.length} wholesale prices to delete\n`)

        if (wholesalePriceIds.length === 0) {
            log("✅ No wholesale prices found")
            return { success: true, deleted: 0 }
        }

        // Delete in batches
        const batchSize = 100
        let deleted = 0

        for (let i = 0; i < wholesalePriceIds.length; i += batchSize) {
            const batch = wholesalePriceIds.slice(i, i + batchSize)
            await pricingModuleService.deletePrices(batch)
            deleted += batch.length

            if (deleted % 100 === 0 || deleted === wholesalePriceIds.length) {
                log(`✓ Deleted ${deleted}/${wholesalePriceIds.length}...`)
            }
        }

        log(`\n✅ Deleted ${deleted} wholesale prices`)
        log("✅ All variants now have only 1 default price\n")

        return { success: true, deleted }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        throw error
    }
}
