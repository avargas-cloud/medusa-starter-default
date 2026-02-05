/**
 * Create Wholesale Prices (Fixed for Medusa v2)
 * 
 * Creates wholesale prices (10% off) for all variants
 * Uses smart rounding: .25, .50, .75, or .99
 */

import { Modules } from "@medusajs/framework/utils"

// Helper: Round price to .25, .50, .75, or .99
function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars

    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export default async function createWholesalePrices({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve("query")
    const pricingModuleService = container.resolve(Modules.PRICING)

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log("\n💰 CREATING WHOLESALE PRICES\n")

    try {
        // 1. Get Wholesale Price List
        const priceLists = await pricingModuleService.listPriceLists({
            title: ["Wholesale Pricing"]
        })

        if (priceLists.length === 0) {
            log("❌ Wholesale Pricing price list not found")
            return { success: false, error: "Price list not found" }
        }

        const wholesalePriceList = priceLists[0]
        log(`✅ Found Wholesale Price List (${wholesalePriceList.id})`)

        // 2. Get all price sets
        const priceSets = await pricingModuleService.listPriceSets({}, {
            relations: ["prices"]
        })

        log(`\n📊 Found ${priceSets.length} price sets`)
        log(`\n💲 Creating wholesale prices (10% off, smart rounded)...\n`)

        let created = 0
        let skipped = 0
        let alreadyExists = 0

        for (const priceSet of priceSets) {
            // Find default USD price (no price_list_id)
            const defaultPrice = priceSet.prices?.find((p: any) =>
                !p.price_list_id && p.currency_code === "usd"
            )

            if (!defaultPrice || defaultPrice.amount === 0) {
                skipped++
                continue
            }

            // Check if wholesale price already exists
            const existingWholesale = priceSet.prices?.find((p: any) =>
                p.price_list_id === wholesalePriceList.id
            )

            if (existingWholesale) {
                alreadyExists++
                continue
            }

            try {
                // Calculate wholesale price (10% off, smart rounded)
                // MEDUSA V2: Prices are already in DOLLARS, not cents!
                const wholesalePrice = smartRound(defaultPrice.amount * 0.9)

                // Create wholesale price in this price set
                await pricingModuleService.addPrices({
                    priceSetId: priceSet.id,
                    prices: [{
                        amount: wholesalePrice, // Already in dollars
                        currency_code: "usd",
                        rules: {
                            price_list_id: wholesalePriceList.id
                        }
                    }]
                })

                created++

                if (created % 50 === 0) {
                    log(`  ✓ Created ${created} wholesale prices...`)
                }

            } catch (error: any) {
                log(`  ⚠️  Failed for price set ${priceSet.id}: ${error.message}`)
                skipped++
            }
        }

        log(`\n${"=".repeat(70)}`)
        log("✅ WHOLESALE PRICES CREATED!")
        log("=".repeat(70))
        log(`💲 Prices Created: ${created}`)
        log(`✅ Already Existed: ${alreadyExists}`)
        log(`⚠️  Skipped (no default price): ${skipped}`)
        log(`📦 Total Price Sets: ${priceSets.length}`)
        log("=".repeat(70))

        // Sample verification
        if (created > 0) {
            log("\n📝 Sample Verification:")
            const sampleSet = priceSets.find((ps: any) =>
                ps.prices?.some((p: any) => p.price_list_id === wholesalePriceList.id)
            )

            if (sampleSet) {
                const defaultP = sampleSet.prices?.find((p: any) => !p.price_list_id)
                const wholesaleP = sampleSet.prices?.find((p: any) => p.price_list_id === wholesalePriceList.id)

                if (defaultP && wholesaleP) {
                    const discount = ((defaultP.amount - wholesaleP.amount) / defaultP.amount * 100).toFixed(1)
                    log(`   Default: $${defaultP.amount.toFixed(2)}`)
                    log(`   Wholesale: $${wholesaleP.amount.toFixed(2)}`)
                    log(`   Discount: ${discount}%`)
                }
            }
        }

        log("\n✅ Done! Wholesale customers will now see discounted prices.")

        return {
            success: true,
            created,
            alreadyExists,
            skipped,
            total: priceSets.length
        }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        throw error
    }
}
