/**
 * Create Price Sets and Assign Prices - CORRECTED
 * 
 * Following Medusa v2 architecture:
 * - Uses Remote Link to connect Variant <-> Price Set
 * - Creates retail ($10) and wholesale ($9.25) prices with rules
 */

import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

// Helper: Round to .25, .50, .75, or .99
function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars

    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export default async function createPriceSetsAndAssignPrices({ container }: ExecArgs) {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const pricingModule = container.resolve(Modules.PRICING)
    const remoteLink = container.resolve(ContainerRegistrationKeys.REMOTE_LINK) // ✅ CRITICAL
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("💰 Creating Price Sets and Assigning Prices...")

    const retailPrice = 10.00
    const wholesalePrice = smartRound(retailPrice * 0.9) // $9.25

    logger.info(`  Retail: $${retailPrice}`)
    logger.info(`  Wholesale: $${wholesalePrice}`)

    try {
        // Get Wholesale customer group ID
        const { data: customerGroups } = await query.graph({
            entity: "customer_group",
            fields: ["id", "name"],
            filters: { name: "Wholesale" },
        })

        const wholesaleGroupId = customerGroups[0]?.id

        if (!wholesaleGroupId) {
            throw new Error("Wholesale customer group not found. Run setup-price-tiers.ts first.")
        }

        logger.info(`  Wholesale Group ID: ${wholesaleGroupId}`)

        // Get all variants
        const { data: variants } = await query.graph({
            entity: "variant",
            fields: ["id", "sku", "title", "price_set.id"],
        })

        logger.info(`\nFound ${variants.length} total variants`)

        const variantsNeedingPriceSets = variants.filter((v: any) => !v.price_set)
        const variantsWithPriceSets = variants.filter((v: any) => v.price_set)

        logger.info(`  ${variantsNeedingPriceSets.length} need Price Sets`)
        logger.info(`  ${variantsWithPriceSets.length} already have Price Sets`)

        let pricesAssigned = 0
        let priceSetsCreated = 0

        // Phase 1: Create Price Sets with BOTH prices (Retail + Wholesale)
        logger.info("\n🏗️  Phase 1: Creating Price Sets with Retail + Wholesale Prices...")

        for (const variant of variantsNeedingPriceSets) {
            try {
                // Create Price Set with BOTH prices
                const [priceSet] = await pricingModule.createPriceSets([
                    {
                        prices: [
                            {
                                currency_code: "usd",
                                amount: retailPrice,
                                rules: {}, // No rules = base retail price
                            },
                            {
                                currency_code: "usd",
                                amount: wholesalePrice,
                                rules: {
                                    customer_group_id: wholesaleGroupId, // ✅ Wholesale rule
                                }
                            }
                        ]
                    }
                ])

                // ✅ CRITICAL: Use Remote Link to connect Variant <-> Price Set
                await remoteLink.create({
                    [Modules.PRODUCT]: {
                        variant_id: variant.id,
                    },
                    [Modules.PRICING]: {
                        price_set_id: priceSet.id,
                    },
                })

                priceSetsCreated++
                pricesAssigned += 2 // Retail + Wholesale

                if (priceSetsCreated % 50 === 0) {
                    logger.info(`  ✓ Created ${priceSetsCreated}/${variantsNeedingPriceSets.length} Price Sets...`)
                }

            } catch (error: any) {
                logger.error(`  ✗ Failed for ${variant.sku || variant.id}: ${error.message}`)
            }
        }

        // Phase 2: Add prices to existing Price Sets
        logger.info("\n💲 Phase 2: Adding Prices to Existing Price Sets...")

        for (const variant of variantsWithPriceSets) {
            try {
                // Skip if price_set is null (shouldn't happen but TypeScript safety)
                if (!variant.price_set) continue;

                // Add both retail and wholesale prices
                await pricingModule.addPrices({
                    priceSetId: variant.price_set.id,
                    prices: [
                        {
                            currency_code: "usd",
                            amount: retailPrice,
                            rules: {},
                        },
                        {
                            currency_code: "usd",
                            amount: wholesalePrice,
                            rules: {
                                customer_group_id: wholesaleGroupId,
                            }
                        }
                    ]
                })

                pricesAssigned += 2

                if (pricesAssigned % 100 === 0) {
                    logger.info(`  ✓ Assigned ${pricesAssigned} prices...`)
                }

            } catch (error: any) {
                // Might fail if prices already exist (duplicate), that's OK
                logger.warn(`  ! Note for ${variant.sku}: ${error.message}`)
            }
        }

        logger.info("\n" + "=".repeat(60))
        logger.info("✅ COMPLETE!")
        logger.info("=".repeat(60))
        logger.info(`🏗️  Price Sets Created: ${priceSetsCreated}`)
        logger.info(`💲 Total Prices Assigned: ${pricesAssigned}`)
        logger.info(`📊 Total Variants: ${variants.length}`)
        logger.info("=".repeat(60))

        logger.info("\n📝 Next Steps:")
        logger.info("1. Verify in Admin: http://localhost:9000/app/products")
        logger.info("2. Create test customers in Retail and Wholesale groups")
        logger.info("3. Test pricing in checkout")
        logger.info("4. Prepare QuickBooks sync")

        return {
            success: true,
            priceSetsCreated,
            pricesAssigned,
            total: variants.length,
        }

    } catch (error: any) {
        logger.error(`\n❌ Error: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}
