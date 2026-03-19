/**
 * Verify Customer Price List Assignments
 * 
 * Checks if customers with metadata.qb_price_level = "Wholesale"
 * are correctly assigned to the "Wholesale" customer group.
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

export default async function verifyPriceLists({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    logger.info("\n🔍 VERIFYING CUSTOMER PRICE LIST ASSIGNMENTS\n")

    try {
        // 1. Get Wholesale customer group
        const { data: wholesaleGroups } = await query.graph({
            entity: "customer_group",
            fields: ["id", "name"],
            filters: { name: "Wholesale" },
        })

        if (wholesaleGroups.length === 0) {
            logger.warn("❌ No 'Wholesale' customer group found!")
            return { success: false, reason: "no_wholesale_group" }
        }

        const wholesaleGroup = wholesaleGroups[0]
        logger.info(`✓ Found Wholesale Group (ID: ${wholesaleGroup.id})`)

        // 2. Get all customers with their groups and metadata
        const { data: allCustomers } = await query.graph({
            entity: "customer",
            fields: ["id", "email", "metadata", "groups.id", "groups.name"],
        })

        // 3. Analyze customers by price level
        const wholesaleMetadata = allCustomers.filter((c: any) =>
            c.metadata?.qb_price_level === "Wholesale"
        )
        const retailMetadata = allCustomers.filter((c: any) =>
            c.metadata?.qb_price_level === "Retail" || !c.metadata?.qb_price_level
        )

        const wholesaleInGroup = wholesaleMetadata.filter((c: any) =>
            c.groups?.some((g: any) => g.name === "Wholesale")
        )
        const wholesaleNotInGroup = wholesaleMetadata.filter((c: any) =>
            !c.groups?.some((g: any) => g.name === "Wholesale")
        )

        logger.info("\n📊 RESULTS:")
        logger.info("─".repeat(70))
        logger.info(`Total Customers: ${allCustomers.length}`)
        logger.info(`  With qb_price_level='Wholesale': ${wholesaleMetadata.length}`)
        logger.info(`  With qb_price_level='Retail' or null: ${retailMetadata.length}`)
        logger.info("─".repeat(70))
        logger.info(`\n✅ Wholesale metadata + In Wholesale group: ${wholesaleInGroup.length}`)
        logger.info(`❌ Wholesale metadata + NOT in any group: ${wholesaleNotInGroup.length}`)
        logger.info("─".repeat(70))

        if (wholesaleNotInGroup.length > 0) {
            logger.info("\n⚠️  CUSTOMERS WITH WHOLESALE METADATA BUT NOT IN GROUP:")
            wholesaleNotInGroup.slice(0, 10).forEach((c: any) => {
                const groups = c.groups?.map((g: any) => g.name).join(", ") || "None"
                logger.info(`  - ${c.email} (Groups: ${groups})`)
            })
            if (wholesaleNotInGroup.length > 10) {
                logger.info(`  ... and ${wholesaleNotInGroup.length - 10} more`)
            }
        }

        return {
            success: true,
            stats: {
                total: allCustomers.length,
                wholesaleMetadata: wholesaleMetadata.length,
                retailMetadata: retailMetadata.length,
                wholesaleInGroup: wholesaleInGroup.length,
                wholesaleNotInGroup: wholesaleNotInGroup.length,
                missingAssignments: wholesaleNotInGroup.map((c: any) => ({
                    id: c.id,
                    email: c.email,
                    currentGroups: c.groups?.map((g: any) => g.name) || []
                }))
            }
        }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        throw error
    }
}
