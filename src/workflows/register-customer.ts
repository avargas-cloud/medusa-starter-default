import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

// Step 1: Create Auth Identity
const createAuthIdentityStep = createStep(
    "create-auth-identity",
    async (input: { email: string; password: string }, { container }) => {
        const authModule = container.resolve(Modules.AUTH)

        // Create identity using 'emailpass' provider
        const authIdentity = await authModule.createAuthIdentities({
            provider_identities: [{
                entity_id: input.email,
                provider: "emailpass",
                user_metadata: { password: input.password } // Provider handles hashing
            }]
        })

        return new StepResponse(authIdentity, authIdentity.id)
    },
    // Compensation logic (rollback) if something fails after
    async (authId, { container }) => {
        if (!authId) return
        const authModule = container.resolve(Modules.AUTH)
        await authModule.deleteAuthIdentities([authId])
    }
)

// Step 2: Create Customer Profile
const createCustomerStep = createStep(
    "create-customer-profile",
    async (input: { authId: string; email: string; first_name: string; last_name: string; metadata?: any }, { container }) => {
        const customerModule = container.resolve(Modules.CUSTOMER)

        const customer = await customerModule.createCustomers({
            email: input.email,
            first_name: input.first_name,
            last_name: input.last_name,
            has_account: true, // Important to allow login
            metadata: input.metadata || {}
        })

        return new StepResponse(customer, customer.id)
    },
    async (customerId, { container }) => {
        if (!customerId) return
        const customerModule = container.resolve(Modules.CUSTOMER)
        await customerModule.deleteCustomers([customerId])
    }
)

// Step 3: Index Customer in MeiliSearch
const indexCustomerInMeiliSearchStep = createStep(
    "index-customer-meilisearch",
    async (input: { customerId: string }, { container }) => {
        try {
            const { MeiliSearch } = await import("meilisearch")
            const query = container.resolve("query") as any

            const client = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST!,
                apiKey: process.env.MEILISEARCH_API_KEY!,
            })

            const index = client.index("customers")

            // Fetch the customer we just created
            const { data: customers } = await query.graph({
                entity: "customer",
                filters: { id: input.customerId },
                fields: [
                    "id", "email", "first_name", "last_name", "phone",
                    "company_name", "has_account", "created_at", "updated_at",
                    "metadata", "groups.*",
                ]
            })

            const customer = customers[0]

            if (!customer) {
                throw new Error(`Customer ${input.customerId} not found for indexing`)
            }

            // Transform to MeiliSearch format
            const meiliCustomer = {
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
            }

            // Index in MeiliSearch
            await index.addDocuments([meiliCustomer], { primaryKey: "id" })

            console.log(`✅ Indexed customer ${customer.email} in MeiliSearch`)

            return new StepResponse({ indexed: true, customerId: input.customerId })
        } catch (error) {
            console.error('MeiliSearch indexing error:', error)
            // Don't fail the whole workflow if MeiliSearch fails
            return new StepResponse({ indexed: false, customerId: input.customerId, error: error instanceof Error ? error.message : 'Unknown error' })
        }
    }
)

// Workflow Definition
export const registerCustomerWorkflow = createWorkflow(
    "register-customer",
    (input: {
        email: string
        password: string
        first_name: string
        last_name: string
        metadata?: any
    }) => {
        // 1. Create Auth
        const authIdentity = createAuthIdentityStep({
            email: input.email,
            password: input.password
        })

        // 2. Create Customer
        const customer = createCustomerStep({
            authId: authIdentity.id,
            email: input.email,
            first_name: input.first_name,
            last_name: input.last_name,
            metadata: input.metadata
        })

        // 3. Index in MeiliSearch
        indexCustomerInMeiliSearchStep({ customerId: customer.id })

        return new WorkflowResponse(customer)
    }
)
