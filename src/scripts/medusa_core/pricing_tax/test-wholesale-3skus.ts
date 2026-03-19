/**
 * TEST: Fix wholesale prices for 3 specific SKUs
 *
 * Validates the correct approach BEFORE running the full QB sync:
 *   - price_list_id = FK directly on the price record
 *   - rules: { customer_group_id } so Medusa's calculator applies it to wholesale customers
 *   - Bulk delete old + bulk create new (no duplicates)
 *
 * Run: yarn medusa exec ./src/scripts/fix/test-wholesale-3skus.ts
 */
import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"
import { ContainerRegistrationKeys } from "@medusajs/utils"

const TARGET_SKUS = [
    "ESPFC4R4N50W0830",
    "ESPFC4R4N50W0840",
    "ESPFC4R4N50W0860",
]

function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars
    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export default async function testWholesale3Skus({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    // Use 'any' to avoid type mismatch — same as fix-wholesale-pricing.ts
    const pricingService: any = container.resolve(Modules.PRICING)
    const customerModule: any = container.resolve(Modules.CUSTOMER)

    logger.info("🧪 Testing wholesale price fix on 3 SKUs...\n")

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

    // 3. Get the 3 variants with their price sets and prices
    const { data: variants } = await query.graph({
        entity: "product_variant",
        fields: [
            "id",
            "sku",
            "prices.id",
            "prices.amount",
            "prices.currency_code",
            "prices.price_list_id",
            "price_set.id",
        ],
    })

    const targetVariants = variants.filter((v: any) => TARGET_SKUS.includes(v.sku))
    logger.info(`\n📦 Found ${targetVariants.length} target variants:\n`)

    const newWholesalePrices: any[] = []

    for (const variant of targetVariants) {
        const usdPrices = (variant.prices || []).filter((p: any) => p.currency_code === "usd")
        // Retail = highest USD price
        const retailPrice = usdPrices.length > 0
            ? usdPrices.reduce((max: any, p: any) => p.amount > max.amount ? p : max)
            : null

        const retailAmount = retailPrice?.amount ?? 0
        const wholesaleAmount = smartRound(retailAmount * 0.9)

        logger.info(`  SKU: ${variant.sku}`)
        logger.info(`    Retail:    $${retailAmount.toFixed(2)}`)
        logger.info(`    Wholesale: $${wholesaleAmount.toFixed(2)} (10% off)`)
        logger.info(`    PriceSet:  ${variant.price_set?.id}`)

        if (variant.price_set?.id && retailAmount > 0) {
            newWholesalePrices.push({
                price_set_id: variant.price_set.id,
                price_list_id: wholesalePriceList.id,   // ← FK DIRECTO (not in rules!)
                currency_code: "usd",
                amount: wholesaleAmount,
                rules: {
                    customer_group_id: wholesaleGroupId  // ← what Medusa uses to apply price
                }
            })
        }
    }

    if (newWholesalePrices.length === 0) {
        logger.error("❌ No wholesale prices to create")
        return
    }

    // 4. Delete only the wholesale prices for these specific price_sets
    //    (avoids touching other products' wholesale prices)
    const priceSetIds = newWholesalePrices.map((p) => p.price_set_id)
    const existingInPriceList = await pricingService.listPrices({
        price_list_id: [wholesalePriceList.id],
        price_set_id: priceSetIds,
    })

    logger.info(`\n🗑️  Deleting ${existingInPriceList.length} old wholesale prices for these SKUs...`)
    if (existingInPriceList.length > 0) {
        await pricingService.deletePrices(existingInPriceList.map((p: any) => p.id))
        logger.info(`   ✔️  Deleted`)
    }

    // 5. Create new wholesale prices
    logger.info(`\n💾 Creating ${newWholesalePrices.length} new wholesale prices...`)
    await pricingService.createPrices(newWholesalePrices)
    logger.info(`   ✔️  Done!`)

    // 6. Verify — re-query the price list to confirm
    logger.info(`\n🔍 Verifying...`)
    const verified = await pricingService.listPrices({
        price_list_id: [wholesalePriceList.id],
        price_set_id: priceSetIds,
    })
    for (const p of verified) {
        logger.info(`   ✅ price_id: ${p.id} | $${p.amount} USD | price_list_id: ${p.price_list_id}`)
    }

    logger.info("\n✅ TEST COMPLETE — Check the wholesale price list in admin UI and test the frontend!")
}
