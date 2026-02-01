import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { registerCustomerWorkflow } from "../../../../workflows/register-customer"

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
            // Send activation email via SendGrid
            try {
                const notificationModule = req.scope.resolve("notificationModuleService") as any

                // Generate activation token (simple for now - in production use JWT or secure token)
                const activationToken = Buffer.from(`${existingCustomer.id}:${Date.now()}`).toString('base64')
                const activationLink = `${process.env.STOREFRONT_URL}/activate?token=${activationToken}`

                await notificationModule.createNotifications({
                    to: email,
                    channel: "email",
                    template: "customer-activation",
                    data: {
                        customer_name: existingCustomer.first_name || "Customer",
                        activation_link: activationLink,
                        email: email
                    }
                })

                console.log(`✅ Activation email sent to ${email}`)

                return res.status(200).json({
                    success: true,
                    needs_activation: true,
                    message: "Activation email sent. Please check your inbox to complete registration.",
                    email: email
                })
            } catch (emailError) {
                console.error('SendGrid email error:', emailError)
                // Return success anyway - don't block registration on email failure
                return res.status(200).json({
                    success: true,
                    needs_activation: true,
                    message: "Registration initiated. If you don't receive an email, please contact support.",
                    email: email,
                    warning: "Email sending failed"
                })
            }
        }

        // Case 1: New customer - use custom workflow to create Auth Identity + Customer
        const { result: customer, errors } = await registerCustomerWorkflow(req.scope).run({
            input: {
                email,
                password,
                first_name,
                last_name,
                metadata: {
                    created_via: "storefront_registration",
                    registered_at: new Date().toISOString()
                }
            },
            throwOnError: false
        })

        if (errors && errors.length > 0) {
            console.error('Registration workflow errors:', errors)
            return res.status(500).json({
                error: "Registration failed",
                details: errors[0]?.error?.message || 'Unknown error'
            })
        }

        return res.status(201).json({
            success: true,
            needs_activation: false,
            message: "Account created successfully",
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
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
