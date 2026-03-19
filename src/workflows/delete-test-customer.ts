import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/utils"

// Step 1: Delete Auth Identity
const deleteAuthIdentityStep = createStep(
    "delete-auth-identity",
    async (email: string, { container }) => {
        const authModule = container.resolve(Modules.AUTH)

        // Find all identities (we'll filter by email manually)
        const identities = await authModule.listAuthIdentities()

        // Find the one matching this email
        const matchingIdentity = identities.find((identity: any) =>
            identity.provider_identities?.some((pi: any) => pi.entity_id === email)
        )

        if (matchingIdentity) {
            await authModule.deleteAuthIdentities([matchingIdentity.id])
            return new StepResponse({ deleted: true, id: matchingIdentity.id })
        }

        return new StepResponse({ deleted: false })
    }
)

// Step 2: Delete Customer Profile
const deleteCustomerStep = createStep(
    "delete-customer-profile",
    async (email: string, { container }) => {
        const customerModule = container.resolve(Modules.CUSTOMER)

        const customers = await customerModule.listCustomers({
            email: email
        })

        if (customers.length > 0) {
            const customer = customers[0]!
            await customerModule.deleteCustomers([customer.id])
            return new StepResponse({ deleted: true, id: customer.id })
        }

        return new StepResponse({ deleted: false })
    }
)

// Main Workflow
export const deleteTestCustomerWorkflow = createWorkflow(
    "delete-test-customer",
    (email: string) => {
        const authResult = deleteAuthIdentityStep(email)
        const customerResult = deleteCustomerStep(email)

        return new WorkflowResponse({
            message: "Customer cleanup completed",
            auth_deleted: authResult,
            customer_deleted: customerResult
        })
    }
)
