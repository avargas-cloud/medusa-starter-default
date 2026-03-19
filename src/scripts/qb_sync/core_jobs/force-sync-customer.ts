import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"

/**
 * Force sync specific customer to Meilisearch
 * Run with: npx medusa exec ./src/scripts/force-sync-customer.ts
 */
export default async function forceSyncCustomer({ container }: ExecArgs) {
    const logger = container.resolve("logger")

    const customerEmail = "a.vargas@ecopowertech.com"

    try {
        logger.info(`🔄 Force syncing customer: ${customerEmail}`)

        // Import Meilisearch
        const { MeiliSearch } = await import("meilisearch")
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })

        // Get customer with groups
        const customerModule = container.resolve(Modules.CUSTOMER)
        const customers = await customerModule.listCustomers({
            email: customerEmail
        }, {
            relations: ["groups"]
        })

        if (customers.length === 0) {
            logger.error(`❌ Customer not found: ${customerEmail}`)
            return
        }

        const customer = customers[0]
        logger.info(`✅ Found customer: ${customer.id}`)

        // Get existing customer_type from metadata (DON'T CHANGE IT!)
        // customer_type = business category (Independent Contractor, Electrician, etc)
        const existingCustomerType = (customer.metadata as any)?.customer_type || "Standard"

        // Get price level from customer groups
        // price_level = Retail or Wholesale (based on customer group)
        let priceLevel = "Retail"

        if (customer.groups && customer.groups.length > 0) {
            const groupNames = customer.groups.map(g => g.name)
            logger.info(`   Groups: ${groupNames.join(', ')}`)

            if (groupNames.includes("Wholesale")) {
                priceLevel = "Wholesale"
            }
        }

        // Build Meilisearch document
        const meiliDoc = {
            id: customer.id,
            email: customer.email,
            first_name: customer.first_name || "",
            last_name: customer.last_name || "",
            company: (customer as any).company_name || "",
            phone: customer.phone || "",
            customer_type: existingCustomerType, // ← PRESERVE metadata value
            price_level: priceLevel,              // ← UPDATE from groups
            status: customer.has_account ? "Registered" : "Guest",
            customer_groups: customer.groups?.map(g => g.name) || [],
            updated_at: new Date(customer.updated_at).getTime(),
            created_at: new Date(customer.created_at).getTime(),
        }

        logger.info(`\n📦 Meilisearch document:`)
        logger.info(`   customer_type: "${meiliDoc.customer_type}" (from metadata)`)
        logger.info(`   price_level: "${meiliDoc.price_level}" (from groups)`)
        logger.info(`   groups: ${meiliDoc.customer_groups.join(', ') || 'none'}`)

        // Update in Meilisearch
        const index = client.index("customers")
        await index.updateDocuments([meiliDoc])

        logger.info(`\n✅ Customer synced to Meilisearch!`)
        logger.info(`   Refresh customers-advanced to see the update`)

    } catch (error: any) {
        logger.error(`❌ Error: ${error.message}`)
        logger.error(error.stack)
    }
}
