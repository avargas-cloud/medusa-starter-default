import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import scryptKdf from "scrypt-kdf"

// Step 1: Create Auth Identity with MANUAL password hashing
const createAuthIdentityStep = createStep(
    "create-auth-identity",
    async (input: { email: string; password: string }, { container }) => {
        const authModule = container.resolve(Modules.AUTH)

        // CRITICAL FIX: createAuthIdentities is LOW-LEVEL and does NOT hash automatically
        // We MUST hash the password manually before passing it
        // Using scrypt-kdf (same library as @medusajs/auth-emailpass provider)
        const hashConfig = { logN: 15, r: 8, p: 1 }
        const passwordHash = await scryptKdf.kdf(input.password, hashConfig)
        const hashedPasswordBase64 = passwordHash.toString("base64")

        // Create auth identity with HASHED password in provider_metadata
        // This matches what the emailpass provider's register() method does internally
        const authIdentities = await authModule.createAuthIdentities({
            provider_identities: [{
                entity_id: input.email,
                provider: "emailpass",
                // CRITICAL: Store in provider_metadata.password (NOT user_metadata)
                // The emailpass provider looks for password in provider_metadata during login
                provider_metadata: {
                    password: hashedPasswordBase64
                }
            }]
        })

        const authIdentity = authIdentities[0]
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

// Step 3: Link Auth Identity to Customer (Optional but recommended)
const linkAuthToCustomerStep = createStep(
    "link-auth-to-customer",
    async (input: { authId: string; customerId: string; actorType: string }, { container }) => {
        const authModule = container.resolve(Modules.AUTH)

        // Update auth identity with app_metadata to link it to the customer
        await authModule.updateAuthIdentities(input.authId, {
            app_metadata: {
                customer_id: input.customerId
            }
        })

        return new StepResponse({ success: true })
    }
)

// WORKFLOW PRINCIPAL
export const registerCustomerWorkflow = createWorkflow(
    "register-customer",
    (input: { email: string; password: string; first_name: string; last_name: string; metadata?: any }) => {
        // Step 1: Create Auth Identity (with manual hashing)
        const authIdentity = createAuthIdentityStep({
            email: input.email,
            password: input.password
        })

        // Step 2: Create Customer Profile
        const customer = createCustomerStep({
            authId: authIdentity.id,
            email: input.email,
            first_name: input.first_name,
            last_name: input.last_name,
            metadata: input.metadata
        })

        // Step 3: Link Auth to Customer
        linkAuthToCustomerStep({
            authId: authIdentity.id,
            customerId: customer.id,
            actorType: "customer"
        })

        return new WorkflowResponse({
            customer,
            authIdentity
        })
    }
)
