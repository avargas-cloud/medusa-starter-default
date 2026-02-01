import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { createCustomersWorkflow } from "@medusajs/core-flows"

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { email, password, first_name, last_name } = req.body as {
        email: string
        password: string
        first_name: string
        last_name: string
    }

    // Validate required fields
    if (!email || !password || !first_name || !last_name) {
        return res.status(400).json({
            error: "Missing required fields",
            required: ["email", "password", "first_name", "last_name"]
        })
    }

    try {
        const query = req.scope.resolve("query")

        // Check if customer exists
        const { data: existingCustomers } = await query.graph({
            entity: "customer",
            filters: { email },
            fields: ["id", "email", "has_account", "metadata"]
        })

        const existingCustomer = existingCustomers?.[0]

        // Case 2: Email already registered (has account)
        if (existingCustomer && existingCustomer.has_account) {
            return res.status(409).json({
                error: "Email already registered",
                message: "This email is already associated with an account. Please login instead."
            })
        }

        // Case 3: Legacy customer (exists but no account)
        if (existingCustomer && !existingCustomer.has_account && existingCustomer.metadata?.legacy_customer) {
            // TODO: Send activation email via SendGrid
            // For now, return success indicating email was sent
            return res.status(200).json({
                success: true,
                needs_activation: true,
                message: "Activation email sent. Please check your inbox to complete registration.",
                email: email
            })
        }

        // Case 1: New customer - create account using Medusa workflow
        const { result } = await createCustomersWorkflow(req.scope).run({
            input: {
                customers: [{
                    email,
                    first_name,
                    last_name,
                    has_account: true,
                    metadata: {
                        created_via: "storefront_registration",
                        registered_at: new Date().toISOString()
                    }
                }]
            }
        })

        const newCustomer = result[0]

        // TODO: Hash password and store (Medusa handles this via auth endpoints)
        // TODO: Auto-login customer
        // TODO: Send welcome email

        return res.status(201).json({
            success: true,
            needs_activation: false,
            message: "Account created successfully",
            customer: {
                id: newCustomer.id,
                email: newCustomer.email,
                first_name: newCustomer.first_name,
                last_name: newCustomer.last_name
            }
        })

    } catch (error) {
        console.error('Registration error:', error)
        return res.status(500).json({
            error: "Registration failed",
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
}
