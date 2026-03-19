/**
 * Migrate Customers to Price Groups
 * 
 * Assigns customers to the correct customer group based on their qb_price_level:
 * - qb_price_level='Wholesale' → "Wholesale" group (10% discount)
 * - qb_price_level='Retail' or null → "Retail" group (regular price)
 * 
 * Set DRY_RUN=true to preview changes without executing
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

const DRY_RUN = process.env.DRY_RUN === "true"

export default async function migrateCustomersToPriceGroups({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const customerModuleService = container.resolve(Modules.CUSTOMER)

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log(`\n🔄 MIGRATING CUSTOMERS TO PRICE GROUPS ${DRY_RUN ? "(DRY RUN)" : ""}\n`)

    try {
        // 1. Get customer groups
        const { data: groups } = await query.graph({
            entity: "customer_group",
            fields: ["id", "name"],
        })

        const retailGroup = groups.find((g: any) => g.name === "Retail")
        const wholesaleGroup = groups.find((g: any) => g.name === "Wholesale")

        if (!retailGroup || !wholesaleGroup) {
            throw new Error("Required customer groups not found. Run setup-price-tiers.ts first.")
        }

        log(`✓ Found Retail Group (${retailGroup.id})`)
        log(`✓ Found Wholesale Group (${wholesaleGroup.id})`)

        // 2. Get all customers with their groups and metadata
        const { data: allCustomers } = await query.graph({
            entity: "customer",
            fields: ["id", "email", "metadata", "groups.id", "groups.name"],
        })

        log(`\n📊 Total Customers: ${allCustomers.length}`)

        // 3. Categorize customers by price level
        const wholesaleCustomers = allCustomers.filter((c: any) =>
            c.metadata?.qb_price_level === "Wholesale"
        )
        const retailCustomers = allCustomers.filter((c: any) =>
            c.metadata?.qb_price_level === "Retail" || !c.metadata?.qb_price_level
        )

        log(`  - Wholesale metadata: ${wholesaleCustomers.length}`)
        log(`  - Retail metadata: ${retailCustomers.length}`)

        // 4. Process wholesale customers
        log("\n💼 Processing Wholesale Customers...")
        let wholesaleMoved = 0
        let wholesaleAlready = 0

        for (const customer of wholesaleCustomers) {
            const inWholesaleGroup = customer.groups?.some((g: any) => g.id === wholesaleGroup.id)

            if (inWholesaleGroup) {
                wholesaleAlready++
            } else {
                if (!DRY_RUN) {
                    // Remove from all current groups
                    const currentGroupIds = customer.groups?.map((g: any) => g.id) || []
                    if (currentGroupIds.length > 0) {
                        await customerModuleService.removeCustomerFromGroup({
                            customer_id: customer.id,
                            customer_group_id: currentGroupIds,
                        })
                    }

                    // Add to Wholesale group
                    await customerModuleService.addCustomerToGroup({
                        customer_id: customer.id,
                        customer_group_id: wholesaleGroup.id,
                    })
                }

                wholesaleMoved++

                if (wholesaleMoved % 100 === 0) {
                    log(`  ✓ Moved ${wholesaleMoved}/${wholesaleCustomers.length} to Wholesale group...`)
                }
            }
        }

        log(`  ✅ Wholesale: ${wholesaleMoved} moved, ${wholesaleAlready} already in group`)

        // 5. Process retail customers
        log("\n🏪 Processing Retail Customers...")
        let retailMoved = 0
        let retailAlready = 0

        for (const customer of retailCustomers) {
            const inRetailGroup = customer.groups?.some((g: any) => g.id === retailGroup.id)

            if (inRetailGroup) {
                retailAlready++
            } else {
                if (!DRY_RUN) {
                    // Remove from all current groups
                    const currentGroupIds = customer.groups?.map((g: any) => g.id) || []
                    if (currentGroupIds.length > 0) {
                        await customerModuleService.removeCustomerFromGroup({
                            customer_id: customer.id,
                            customer_group_id: currentGroupIds,
                        })
                    }

                    // Add to Retail group
                    await customerModuleService.addCustomerToGroup({
                        customer_id: customer.id,
                        customer_group_id: retailGroup.id,
                    })
                }

                retailMoved++

                if (retailMoved % 100 === 0) {
                    log(`  ✓ Moved ${retailMoved}/${retailCustomers.length} to Retail group...`)
                }
            }
        }

        log(`  ✅ Retail: ${retailMoved} moved, ${retailAlready} already in group`)

        // 6. Final summary
        log("\n" + "=".repeat(70))
        log("✅ MIGRATION COMPLETE!")
        log("=".repeat(70))
        log(`💼 Wholesale Customers: ${wholesaleCustomers.length}`)
        log(`   - Moved to Wholesale group: ${wholesaleMoved}`)
        log(`   - Already in Wholesale group: ${wholesaleAlready}`)
        log(`\n🏪 Retail Customers: ${retailCustomers.length}`)
        log(`   - Moved to Retail group: ${retailMoved}`)
        log(`   - Already in Retail group: ${retailAlready}`)
        log("=".repeat(70))
        log("\n📝 Next: Verify wholesale pricing is applied when customers log in")

        return {
            success: true,
            stats: {
                wholesale: { total: wholesaleCustomers.length, moved: wholesaleMoved, already: wholesaleAlready },
                retail: { total: retailCustomers.length, moved: retailMoved, already: retailAlready },
            }
        }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        throw error
    }
}
