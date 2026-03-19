import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"

/**
 * Script to fix pricing configuration:
 * 1. Remove broken price_rules from base prices
 * 2. Set up wholesale pricing correctly with 7.5% discount
 * 
 * Run with: npx medusa exec ./src/scripts/fix/fix-wholesale-pricing.ts
 */
export default async function fixWholesalePricing({ container }: ExecArgs) {
    // Cast to any — deletePrices/createPrices/createRuleTypes exist at runtime
    // but are not declared in the IPricingModuleService interface typings
    const pricingService = container.resolve(Modules.PRICING) as any
    const logger = container.resolve("logger")

    logger.info("=== FIXING PRICING CONFIGURATION ===\n")

    // ---------------------------------------------------------
    // STEP 1: CLEANUP - Remove broken price rules
    // ---------------------------------------------------------
    logger.info("Step 1: Cleaning up existing price rules...")

    const priceSets = await pricingService.listPriceSets({}, {
        relations: ["prices", "prices.price_rules"]
    })

    logger.info(`Found ${priceSets.length} price sets`)

    const pricesToDelete: string[] = []
    const pricesToCreate: any[] = []

    for (const priceSet of priceSets) {
        for (const price of (priceSet.prices ?? [])) {
            // Check if price has rules (from failed wholesale attempt)
            const rules = (price.price_rules ?? [])
            const hasRules = rules.length > 0

            if (hasRules) {
                logger.info(`  ⚠️  Price ${price.id} has ${rules.length} rules - marking for cleanup`)

                // Delete the broken price
                pricesToDelete.push(price.id)

                // Create clean replacement (base price with NO rules)
                pricesToCreate.push({
                    price_set_id: priceSet.id,
                    currency_code: price.currency_code,
                    amount: price.amount, // Keep original amount
                    min_quantity: price.min_quantity,
                    max_quantity: price.max_quantity,
                    rules: {} // EMPTY = base price, no conditions
                })
            }
        }
    }

    if (pricesToDelete.length > 0) {
        logger.info(`  🗑️  Deleting ${pricesToDelete.length} prices with broken rules...`)
        await pricingService.deletePrices(pricesToDelete)

        logger.info(`  ✅ Creating ${pricesToCreate.length} clean base prices...`)
        await pricingService.createPrices(pricesToCreate)

        logger.info(`  ✅ Reset ${pricesToDelete.length} prices to base prices (no rules)`)
    } else {
        logger.info("  ✅ No broken prices found - all clean!")
    }

    // ---------------------------------------------------------
    // STEP 2: SETUP - Create Wholesale Price List (7.5% discount)
    // ---------------------------------------------------------
    logger.info("\nStep 2: Setting up Wholesale pricing...")

    // Ensure customer_group_id rule type exists
    try {
        await pricingService.createRuleTypes([
            {
                name: "Customer Group",
                rule_attribute: "customer_group_id"
            }
        ])
        logger.info("  ✅ Created customer_group_id rule type")
    } catch {
        logger.info("  ℹ️  customer_group_id rule type already exists")
    }

    // Find the Wholesale customer group ID
    const customerModule = container.resolve(Modules.CUSTOMER)
    const customerGroups = await customerModule.listCustomerGroups({
        name: "Wholesale"
    })

    if (customerGroups.length === 0) {
        logger.error("  ❌ ERROR: 'Wholesale' customer group not found!")
        logger.error("     Please create it in Medusa Admin first")
        return
    }

    const wholesaleGroupId = customerGroups[0].id
    logger.info(`  ✅ Found Wholesale group: ${wholesaleGroupId}`)

    // Check if Wholesale price list already exists
    // listPriceLists filter by name — use raw query to avoid typing issues
    const existingPriceLists = await pricingService.listPriceLists({})
    const wholesaleListMatch = existingPriceLists.filter((pl: any) => pl.title === "Wholesale Pricing")

    let wholesaleList: any
    if (wholesaleListMatch.length > 0) {
        logger.info("  ℹ️  Wholesale Pricing list already exists - updating...")
        wholesaleList = wholesaleListMatch[0]

        // Update it to ensure it has correct rules
        await pricingService.updatePriceLists([{
            id: wholesaleList.id,
            status: "active",
            rules: {
                customer_group_id: [wholesaleGroupId]
            }
        }])
    } else {
        logger.info("  ✨ Creating new Wholesale Price List...")
        const [created] = await pricingService.createPriceLists([
            {
                title: "Wholesale Pricing",
                description: "7.5% discount for wholesale customers",
                status: "active",
                type: "override", // Takes precedence over base prices
                rules: {
                    customer_group_id: [wholesaleGroupId]
                }
            }
        ])
        wholesaleList = created
    }

    logger.info(`  ✅ Wholesale Price List: ${wholesaleList.id}`)

    // ---------------------------------------------------------
    // STEP 3: Create Wholesale Prices (7.5% discount)
    // ---------------------------------------------------------
    logger.info("\nStep 3: Creating wholesale prices with 7.5% discount...")

    // Re-fetch clean price sets
    const cleanPriceSets = await pricingService.listPriceSets({}, {
        relations: ["prices"]
    })

    const wholesalePrices: any[] = []

    for (const priceSet of cleanPriceSets) {
        // Find USD base price (no price_list_id = not a price list price)
        const basePrice = (priceSet.prices ?? []).find((p: any) =>
            p.currency_code === "usd" && !p.price_list_id
        )

        if (basePrice) {
            // Calculate 7.5% discount
            const baseAmount = Number(basePrice.amount ?? 0)
            const discountedAmount = Number((baseAmount * 0.925).toFixed(2))

            wholesalePrices.push({
                price_set_id: priceSet.id,
                price_list_id: wholesaleList.id,
                currency_code: "usd",
                amount: discountedAmount,
                rules: {
                    customer_group_id: wholesaleGroupId
                }
            })

            logger.info(`  💰 ${priceSet.id}: $${baseAmount} → $${discountedAmount} (wholesale)`)
        }
    }

    if (wholesalePrices.length > 0) {
        // Delete existing wholesale prices first to avoid duplicates
        const existingWholesalePrices = await pricingService.listPrices({
            price_list_id: [wholesaleList.id]
        })

        if (existingWholesalePrices.length > 0) {
            const idsToDelete = existingWholesalePrices.map((p: any) => p.id)
            await pricingService.deletePrices(idsToDelete)
            logger.info(`  🗑️  Removed ${idsToDelete.length} old wholesale prices`)
        }

        await pricingService.createPrices(wholesalePrices)
        logger.info(`  ✅ Created ${wholesalePrices.length} wholesale prices`)
    }

    logger.info("\n✅ PRICING FIXED!")
    logger.info("   - Base prices: Work for everyone")
    logger.info("   - Wholesale prices: 7.5% discount for Wholesale customer group")
    logger.info("   - calculatePrices() will now work correctly!")
}
