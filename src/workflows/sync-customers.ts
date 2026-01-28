import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

// Simple in-memory lock to prevent concurrent syncs
let isSyncing = false

export const syncCustomersToMeiliStep = createStep(
    "sync-customers-to-meili-step",
    async (_, { container }) => {
        if (isSyncing) {
            console.log("⚠️ Sync requested but already in progress. Skipping.")
            return new StepResponse({
                success: false,
                message: "Sync already in progress",
                synced: 0
            })
        }

        isSyncing = true
        console.log("🔒 Acquired Sync Lock")

        try {
            const { MeiliSearch } = await import("meilisearch")
            const query = container.resolve("query") as any

            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST!,
                apiKey: process.env.MEILISEARCH_API_KEY!,
            })

            const index = client.index("customers")

            // 1. Update Settings (No delete, so old data stays visible during sync)
            await index.updateSettings({
                filterableAttributes: ["customer_type", "price_level", "has_account", "groups"],
                sortableAttributes: ["company_name", "created_at", "updated_at", "email"],
                searchableAttributes: ["company_name", "email", "list_id", "first_name", "last_name", "phone"],
                pagination: { maxTotalHits: 20000 }
            })

            // 2. Batched Fetching & Indexing
            const BATCH_SIZE = 2500
            let offset = 0
            let hasMore = true
            let totalSynced = 0

            console.log(`🚀 Starting Batched Sync (Batch Size: ${BATCH_SIZE})...`)

            while (hasMore) {
                const batchStart = Date.now()
                const { data: customers } = await query.graph({
                    entity: "customer",
                    fields: [
                        "id", "email", "first_name", "last_name", "phone",
                        "company_name", "has_account", "created_at", "updated_at",
                        "metadata", "groups.*",
                    ],
                    options: {
                        order: { created_at: "DESC" }
                    },
                    pagination: {
                        take: BATCH_SIZE,
                        skip: offset
                    }
                })

                if (customers.length === 0) {
                    hasMore = false
                    break
                }

                // Transform
                const meiliCustomers = customers.map((customer: any) => ({
                    id: customer.id,
                    email: customer.email,
                    first_name: customer.first_name,
                    last_name: customer.last_name,
                    company_name: customer.company_name || customer.metadata?.company_name || "",
                    phone: customer.phone,
                    has_account: customer.has_account,
                    created_at: new Date(customer.created_at).getTime(),
                    updated_at: new Date(customer.updated_at).getTime(),
                    list_id: customer.metadata?.qb_list_id || customer.metadata?.quickbooks_list_id || "",
                    price_level: customer.metadata?.qb_price_level || "Retail",
                    customer_type: customer.metadata?.qb_customer_type || "Retail",
                    groups: customer.groups?.map((g: any) => g.name) || []
                }))

                // Index Batch
                await index.addDocuments(meiliCustomers, { primaryKey: "id" })

                totalSynced += meiliCustomers.length
                offset += BATCH_SIZE

                console.log(`📦 Synced Batch ${offset / BATCH_SIZE}: ${meiliCustomers.length} customers in ${Date.now() - batchStart}ms (Total: ${totalSynced})`)

                // Allow event loop to breathe (Critical for server responsiveness)
                await new Promise(resolve => setTimeout(resolve, 20))
            }

            console.log(`✅ Sync Complete! Total Documents: ${totalSynced}`)
            isSyncing = false
            console.log("🔓 Released Sync Lock")

            return new StepResponse({
                success: true,
                message: "Sync completed successfully",
                synced: totalSynced
            })
        } catch (error: any) {
            isSyncing = false
            console.log("🔓 Released Sync Lock (Error)")
            console.error("❌ Sync Workflow Error:", error)
            throw new Error(`Workflow failed: ${error.message}`)
        }
    }
)

export const syncCustomersWorkflow = createWorkflow(
    "sync-customers-workflow",
    () => {
        const result = syncCustomersToMeiliStep()
        return new WorkflowResponse(result)
    }
)
