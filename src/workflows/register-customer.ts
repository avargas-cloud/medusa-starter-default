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
        const customerModule = container.resolve(Modules.CUSTOMER)
        await customerModule.deleteCustomers([customerId])
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

        return new WorkflowResponse(customer)
    }
)
