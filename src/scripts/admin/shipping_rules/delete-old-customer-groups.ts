/**
 * Delete Old Customer Groups
 * 
 * Removes the old "Wholesale Customers" and "Retail Customers" groups
 * that are now empty after migration.
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export default async function deleteOldCustomerGroups({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const customerModuleService = container.resolve(Modules.CUSTOMER)

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log("\n🗑️  DELETING OLD CUSTOMER GROUPS\n")

    try {
        // Get all customer groups
        const { data: groups } = await query.graph({
            entity: "customer_group",
            fields: ["id", "name"],
        })

        const oldGroups = groups.filter((g: any) =>
            g.name === "Wholesale Customers" || g.name === "Retail Customers"
        )

        if (oldGroups.length === 0) {
            log("✓ No old groups found to delete")
            return { success: true, deleted: 0 }
        }

        log(`Found ${oldGroups.length} old groups to delete:`)
        oldGroups.forEach((g: any) => {
            log(`  - ${g.name} (${g.id})`)
        })

        // Delete each old group
        for (const group of oldGroups) {
            await customerModuleService.deleteCustomerGroups([group.id])
            log(`✅ Deleted: ${group.name}`)
        }

        log("\n" + "=".repeat(50))
        log(`✅ CLEANUP COMPLETE! Deleted ${oldGroups.length} groups`)
        log("=".repeat(50))

        return {
            success: true,
            deleted: oldGroups.length,
            groups: oldGroups.map((g: any) => g.name)
        }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        throw error
    }
}
