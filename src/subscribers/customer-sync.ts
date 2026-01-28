import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"

console.log("🔵 [Loader] customer-sync.ts loaded")


export default async function customerSyncSubscriber({
    event,
    container,
}: SubscriberArgs<{ id: string }>) {
    const eventName = event.name
    const customerId = event.data.id

    console.log(`⚡ [Customer Subscriber] Event triggered: ${eventName} for ID: ${customerId}`)

    try {
        // 1. Resolve Services
        const query = container.resolve("query")
        const { MeiliSearch } = await import("meilisearch")
        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })
        const index = client.index("customers")

        // 2. Fetch the specific customer (O(1) lookup)
        const { data: customers } = await query.graph({
            entity: "customer",
            fields: [
                "id", "email", "first_name", "last_name", "phone",
                "company_name", "has_account", "created_at", "updated_at",
                "metadata", "groups.*",
            ],
            filters: {
                id: [customerId]
            }
        })

        if (!customers.length) {
            console.warn(`⚠️ [Customer Subscriber] Customer ${customerId} not found in DB. Skipping index update.`)
            return
        }

        const customer = customers[0]

        // 3. Transform (Same logic as the full workflow)
        const meiliDocument = {
            id: customer.id,
            email: customer.email,
            first_name: customer.first_name,
            last_name: customer.last_name,
            company_name: customer.company_name || customer.metadata?.company_name || "",
            phone: customer.phone,
            has_account: customer.has_account,
            created_at: new Date(customer.created_at).getTime(),
            updated_at: new Date(customer.updated_at).getTime(),

            // QuickBooks Metadata
            list_id: customer.metadata?.qb_list_id || customer.metadata?.quickbooks_list_id || "",
            price_level: customer.metadata?.qb_price_level || "Retail",
            customer_type: customer.metadata?.qb_customer_type || "Retail",

            // Groups
            groups: customer.groups?.map((g: any) => g.name) || []
        }

        // 4. Upsert to MeiliSearch
        await index.addDocuments([meiliDocument], { primaryKey: "id" })

        console.log(`✅ [Customer Subscriber] Successfully synced customer ${customer.email} (${customer.id})`)

    } catch (error: any) {
        console.error(`❌ [Customer Subscriber] Failed to sync ${customerId}:`, error.message)
    }
}

export const config: SubscriberConfig = {
    event: [
        "customer.created",
        "customer.updated",
        "test.event"
    ],
}
