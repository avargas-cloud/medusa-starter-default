/**
 * Setup Price Tiers (Fixed)
 * 
 * This script:
 * 1. Creates Customer Groups (Retail, Wholesale)
 * 2. Sets up Price Lists for Wholesale
 * 3. Assigns placeholder prices ($10 Retail, $9.25 Wholesale) using Pricing Module
 * 4. Applies smart rounding (.25, .50, .75, .99)
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

// Helper: Round price to .25, .50, .75, or .99
function smartRound(price: number): number {
    const dollars = Math.floor(price)
    const cents = price - dollars

    if (cents < 0.25) return dollars + 0.25
    if (cents < 0.50) return dollars + 0.50
    if (cents < 0.75) return dollars + 0.75
    return dollars + 0.99
}

export default async function setupPriceTiers({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const customerModuleService = container.resolve(Modules.CUSTOMER)
    const pricingModuleService = container.resolve(Modules.PRICING)

    logger.info("💰 Setting Up Price Tiers...")

    const report = {
        customerGroups: [] as any[],
        priceLists: [] as any[],
        pricesCreated: 0,
        variantsProcessed: 0,
    }

    try {
        // ========================================
        // PHASE 1: CREATE CUSTOMER GROUPS
        // ========================================
        logger.info("\n👥 PHASE 1: Creating Customer Groups")

        const groupsToCreate = [
            { name: "Retail", metadata: { is_default: true, description: "Standard retail customers" } },
            { name: "Wholesale", metadata: { requires_approval: true, description: "Trade/contractor customers (10% discount)" } },
        ]

        for (const groupData of groupsToCreate) {
            const { data: existing } = await query.graph({
                entity: "customer_group",
                fields: ["id", "name"],
                filters: { name: groupData.name },
            })

            if (existing.length > 0) {
                logger.info(`  ✓ Customer Group "${groupData.name}" already exists (ID: ${existing[0].id})`)
                report.customerGroups.push(existing[0])
            } else {
                const [created] = await customerModuleService.createCustomerGroups([groupData])
                logger.info(`  ✓ Created Customer Group "${groupData.name}" (ID: ${created.id})`)
                report.customerGroups.push(created)
            }
        }

        const wholesaleGroup = report.customerGroups.find(g => g.name === "Wholesale")

        if (!wholesaleGroup) {
            throw new Error("Wholesale customer group not found")
        }

        // ========================================
        // PHASE 2: CREATE WHOLESALE PRICE LIST
        // ========================================
        logger.info("\n💵 PHASE 2: Creating Wholesale Price List")

        const { data: existingPriceLists } = await query.graph({
            entity: "price_list",
            fields: ["id", "title"],
            filters: { title: "Wholesale Pricing" },
        })

        let wholesalePriceList

        if (existingPriceLists.length > 0) {
            wholesalePriceList = existingPriceLists[0]
            logger.info(`  ✓ Wholesale Price List already exists (ID: ${wholesalePriceList.id})`)
        } else {
            const [created] = await pricingModuleService.createPriceLists([{
                title: "Wholesale Pricing",
                description: "10% discount for trade/contractor customers",
                type: "sale",
                status: "active",
            }])

            // Link price list to customer group
            const remoteLink = container.resolve("remoteLink")
            await remoteLink.create({
                priceListModule: {
                    price_list_id: created.id,
                },
                customerModule: {
                    customer_group_id: wholesaleGroup.id,
                },
            })

            wholesalePriceList = created
            logger.info(`  ✓ Created Wholesale Price List (ID: ${wholesalePriceList.id})`)
        }

        report.priceLists.push(wholesalePriceList)

        // ========================================
        // PHASE 3: GET ALL VARIANTS
        // ========================================
        logger.info("\n🏷️  PHASE 3: Getting Product Variants")

        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: ["id", "sku", "title", "product_id"],
        })

        logger.info(`Found ${variants.length} variants`)

        // ========================================
        // PHASE 4: CREATE PRICES
        // ========================================
        logger.info("\n💲 PHASE 4: Creating Prices")

        const retailPrice = 10.00 // $10 USD
        const wholesalePrice = smartRound(retailPrice * 0.9) // 10% off, rounded

        logger.info(`  Retail Price: $${retailPrice.toFixed(2)} USD`)
        logger.info(`  Wholesale Price: $${wholesalePrice.toFixed(2)} USD`)

        // Create prices in batches
        const batchSize = 50
        let created = 0

        for (let i = 0; i < variants.length; i += batchSize) {
            const batch = variants.slice(i, i + batchSize)

            try {
                const pricesToCreate = batch.flatMap((variant: any) => [
                    // Retail price (default)
                    {
                        variant_id: variant.id,
                        currency_code: "usd",
                        amount: Math.round(retailPrice * 100), // $10.00 in cents
                    },
                    // Wholesale price (in price list)
                    {
                        variant_id: variant.id,
                        currency_code: "usd",
                        amount: Math.round(wholesalePrice * 100), // $9.25 in cents
                        price_list_id: wholesalePriceList.id,
                    }
                ])

                await pricingModuleService.createPrices(pricesToCreate)

                created += batch.length * 2 // 2 prices per variant
                report.variantsProcessed += batch.length

                logger.info(`  Created prices for ${report.variantsProcessed}/${variants.length} variants...`)

            } catch (error: any) {
                logger.error(`  ✗ Failed to create prices for batch: ${error.message}`)
            }
        }

        report.pricesCreated = created

        // ========================================
        // FINAL REPORT
        // ========================================
        logger.info("\n" + "=".repeat(60))
        logger.info("✅ PRICE TIERS SETUP COMPLETE!")
        logger.info("=".repeat(60))
        logger.info(`👥 Customer Groups: ${report.customerGroups.length}`)
        logger.info(`💵 Price Lists: ${report.priceLists.length}`)
        logger.info(`🏷️  Variants Processed: ${report.variantsProcessed}`)
        logger.info(`💲 Prices Created: ${report.pricesCreated}`)
        logger.info("=".repeat(60))

        logger.info("\n📝 Next Steps:")
        logger.info("1. Verify prices in Admin: /app/products")
        logger.info("2. Assign customers to Wholesale group for testing")
        logger.info("3. Prepare QuickBooks CSV sync")

        return {
            success: true,
            report,
        }

    } catch (error: any) {
        logger.error(`❌ Error setting up price tiers: ${error.message}`)
        logger.error(error.stack)
        throw error
    }
}
