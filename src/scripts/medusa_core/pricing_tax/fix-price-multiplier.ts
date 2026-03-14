import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IPricingModuleService } from "@medusajs/types"

/**
 * Fix Price Multiplier Error
 * 
 * Problem: All prices are 100x too high (e.g., $5,675.00 instead of $56.75)
 * Cause: Prices were imported as dollars and then multiplied by 100 again
 * Solution: Divide all prices by 100
 */

export default async function fixPriceMultiplier({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    const pricingModule: IPricingModuleService = container.resolve(Modules.PRICING)
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const isDryRun = process.env.DRY_RUN === "true"


    logger.info(`🔧 Fixing Price Multiplier Error (Dry Run: ${isDryRun})...\n`)

    // Fetch all variants with their price sets
    const { data: variants } = await query.graph({
        entity: "variant",
        fields: [
            "id",
            "sku",
            "title",
            "product.title",
            "price_set.id",
            "price_set.prices.id",
            "price_set.prices.amount",
            "price_set.prices.currency_code"
        ]
    })

    logger.info(`📊 Found ${variants.length} variants to analyze\n`)

    let corrected = 0
    let skipped = 0
    let errors = 0

    for (const variant of variants) {
        if (!variant.price_set || !variant.price_set.prices) {
            skipped++
            continue
        }

        const usdPrice = variant.price_set.prices.find((p: any) => p?.currency_code === "usd")

        if (!usdPrice) {
            skipped++
            continue
        }

        const currentAmount = usdPrice.amount
        const newAmount = Math.round(currentAmount / 100)

        // Only fix if the current amount is >= 1000 cents ($10)
        // This prevents accidentally dividing already-correct prices
        if (currentAmount < 1000) {
            skipped++
            continue
        }

        const currentDisplay = (currentAmount / 100).toFixed(2)
        const newDisplay = (newAmount / 100).toFixed(2)

        if (isDryRun) {
            console.log(`[DRY RUN] ${variant.sku}:`)
            console.log(`   Current: $${currentDisplay} (${currentAmount} cents)`)
            console.log(`   New:     $${newDisplay} (${newAmount} cents)`)
            console.log(`   Change:  ÷100`)
            corrected++
        } else {
            try {
                console.log(`🔄 ${variant.sku}: $${currentDisplay} → $${newDisplay}`)

                await pricingModule.updatePriceSets(variant.price_set.id, {
                    prices: [
                        {
                            id: usdPrice.id,
                            amount: newAmount,
                            currency_code: "usd"
                        }
                    ]
                })

                corrected++
            } catch (error: any) {
                console.error(`❌ ${variant.sku}: ${error.message}`)
                errors++
            }
        }
    }

    console.log(`\n\n${"=".repeat(70)}`)
    console.log("📊 SUMMARY")
    console.log("=".repeat(70))
    console.log(`Total Variants:     ${variants.length}`)
    console.log(`Corrected:          ${corrected}`)
    console.log(`Skipped (< $10):    ${skipped}`)
    console.log(`Errors:             ${errors}`)

    if (isDryRun) {
        console.log(`\n⚠️  DRY RUN MODE - No changes were made`)
        console.log(`Run without --dry-run to apply changes:`)
        console.log(`npx medusa exec ./src/scripts/fix-price-multiplier.ts`)
    } else {
        console.log(`\n✅ Done! Refresh the admin to see updated prices.`)
    }

    return { corrected, skipped, errors }
}
