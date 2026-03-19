/**
 * Show Customer Data Structure
 * 
 * Displays all available fields and metadata from customers
 */

import { ContainerRegistrationKeys } from "@medusajs/utils"

export default async function showCustomerData({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    logger.info("\n📊 CUSTOMER DATA STRUCTURE\n")

    try {
        // Get a sample customer with all fields
        const { data: customers } = await query.graph({
            entity: "customer",
            fields: [
                "id",
                "email",
                "first_name",
                "last_name",
                "company_name",
                "phone",
                "has_account",
                "created_at",
                "updated_at",
                "deleted_at",
                "metadata",
                "groups.id",
                "groups.name",
                "groups.metadata",
            ],
            pagination: { take: 3 }
        })

        logger.info(`Found ${customers.length} sample customers:\n`)

        customers.forEach((c: any, i: number) => {
            logger.info(`\n[${+ 1}] ${c.email}`)
            logger.info(`  ID: ${c.id}`)
            logger.info(`  Name: ${c.first_name} ${c.last_name}`)
            logger.info(`  Company: ${c.company_name || 'N/A'}`)
            logger.info(`  Phone: ${c.phone || 'N/A'}`)
            logger.info(`  Has Account: ${c.has_account}`)
            logger.info(`  Created: ${c.created_at}`)
            logger.info(`  Updated: ${c.updated_at}`)
            logger.info(`  Groups: ${c.groups?.map((g: any) => g.name).join(", ") || "None"}`)
            logger.info(`  Metadata: ${JSON.stringify(c.metadata, null, 2)}`)
        })

        logger.info("\n" + "=".repeat(70))
        logger.info("AVAILABLE CUSTOMER FIELDS:")
        logger.info("=".repeat(70))
        logger.info("Core Fields:")
        logger.info("  - id, email, first_name, last_name")
        logger.info("  - company_name, phone, has_account")
        logger.info("  - created_at, updated_at, deleted_at")
        logger.info("\nRelationships:")
        logger.info("  - groups (customer_group[])")
        logger.info("\nMetadata (custom key-value pairs):")
        if (customers.length > 0 && customers[0].metadata) {
            Object.keys(customers[0].metadata).forEach(key => {
                logger.info(`  - ${key}`)
            })
        }
        logger.info("=".repeat(70))

        return { success: true }

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        throw error
    }
}
