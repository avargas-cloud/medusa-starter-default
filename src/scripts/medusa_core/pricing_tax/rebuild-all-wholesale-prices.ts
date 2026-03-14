/**
 * Rebuild ALL Wholesale Prices (10% off retail)
 *
 * Replaces ALL prices in the Wholesale Pricing price list with:
 *   - 10% off the current retail price (max USD price per variant)
 *   - price_list_id as FK directly on the price (not in rules)
 *   - rules: { customer_group_id } so Medusa applies it to wholesale customers
 *
 * Run: yarn medusa exec ./src/scripts/fix/rebuild-all-wholesale-prices.ts
 */
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars
    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export default async function rebuildAllWholesalePrices({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pricingService: any = container.resolve(Modules.PRICING)
    const customerModule: any = container.resolve(Modules.CUSTOMER)

    logger.info("💰 Rebuilding ALL Wholesale Prices (10% off retail)...\n")

    // 1. Find the Wholesale Pricing price list
    const priceLists = await pricingService.listPriceLists({ title: ["Wholesale Pricing"] })
    if (priceLists.length === 0) {
        logger.error("❌ Wholesale Pricing price list not found!")
        return
    }
    const wholesalePriceList = priceLists[0]
    logger.info(`✅ Price List: ${wholesalePriceList.title} (${wholesalePriceList.id})`)

    // 2. Find the Wholesale customer group
    const wholesaleGroups = await customerModule.listCustomerGroups({ name: ["Wholesale"] })
    const wholesaleGroupId = wholesaleGroups[0]?.id
    if (!wholesaleGroupId) {
        logger.error("❌ Wholesale customer group not found!")
        return
    }
    logger.info(`✅ Wholesale Group ID: ${wholesaleGroupId}`)

    // 3. Get all price sets with their prices
    logger.info("\n📊 Fetching all price sets...")
    const priceSets = await pricingService.listPriceSets({}, { relations: ["prices"] })
    logger.info(`   Found ${priceSets.length} price sets`)

    // 4. Build new wholesale prices array
    const newWholesalePrices: any[] = []
    let skipped = 0

    for (const priceSet of priceSets) {
        // Retail = highest USD price (same logic as sync-inventory.ts)
        const usdPrices = (priceSet.prices || []).filter((p: any) =>
            p.currency_code === "usd" && !p.price_list_id  // base retail (no price list FK)
        )

        if (usdPrices.length === 0) {
            skipped++
            continue
        }

        const retailPrice = usdPrices.reduce((max: any, p: any) => p.amount > max.amount ? p : max)
        const wholesaleAmount = smartRound(retailPrice.amount * 0.9)

        newWholesalePrices.push({
            price_set_id: priceSet.id,
            price_list_id: wholesalePriceList.id,   // FK directly on price
            currency_code: "usd",
            amount: wholesaleAmount,
            rules: {
                customer_group_id: wholesaleGroupId  // Medusa applies when this matches
            }
        })
    }

    logger.info(`   Built ${newWholesalePrices.length} new wholesale prices (${skipped} price sets skipped — no retail USD price)`)

    // 5. Delete ALL existing wholesale prices in price list
    logger.info("\n🗑️  Deleting all old wholesale prices from price list...")
    const oldWholesalePrices = await pricingService.listPrices({
        price_list_id: [wholesalePriceList.id]
    })
    if (oldWholesalePrices.length > 0) {
        await pricingService.deletePrices(oldWholesalePrices.map((p: any) => p.id))
        logger.info(`   ✔️  Deleted ${oldWholesalePrices.length} old prices`)
    } else {
        logger.info("   (none to delete)")
    }

    // 6. Create new wholesale prices in bulk
    logger.info(`\n💾 Creating ${newWholesalePrices.length} new wholesale prices...`)
    await pricingService.createPrices(newWholesalePrices)
    logger.info(`   ✔️  Done!`)

    logger.info(`\n✅ WHOLESALE REBUILD COMPLETE`)
    logger.info(`   ${newWholesalePrices.length} products now have correct wholesale pricing (10% off retail)`)
    logger.info(`   price_list_id set as FK — price_list: ${wholesalePriceList.id}`)
    logger.info(`   customer_group_id rule: ${wholesaleGroupId}`)
}
