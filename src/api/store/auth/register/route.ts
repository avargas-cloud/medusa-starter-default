import { Modules } from '@medusajs/framework/utils'
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

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
            fields: ["id", "email", "has_account", "metadata", "first_name"]
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
        if (existingCustomer && !existingCustomer.has_account &&
            (existingCustomer.metadata?.legacy_customer === true || existingCustomer.metadata?.legacy_customer === "true")) {

            console.log('🎯 Legacy customer - sending activation email')

            // Send activation email via SendGrid
            try {
                const sgMail = await import("@sendgrid/mail")
                sgMail.default.setApiKey(process.env.SENDGRID_API_KEY!)

                // Generate activation token
                const activationToken = Buffer.from(`${existingCustomer.id}:${Date.now()}`).toString('base64')
                const activationLink = `${process.env.STOREFRONT_URL || 'http://localhost:3000'}/activate-account?token=${activationToken}`

                // Save temporary password and token in metadata (password will be hashed on activation)
                const customerModule = req.scope.resolve(Modules.CUSTOMER)
                await customerModule.updateCustomers(existingCustomer.id, {
                    metadata: {
                        ...existingCustomer.metadata,
                        temporary_password: password, // Plain text, will be hashed on activation
                        activation_token: activationToken,
                        activation_expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
                    }
                })

                await sgMail.default.send({
                    to: email,
                    from: process.env.SENDGRID_FROM_EMAIL || 'noreply@yourdomain.com',
                    subject: 'Activate Your Account',
                    html: `
                        <h2>Welcome ${existingCustomer.first_name}!</h2>
                        <p>Click the link below to activate your account:</p>
                        <a href="${activationLink}">Activate Account</a>
                        <p>This link expires in 24 hours.</p>
                    `
                })

                console.log('✅ Activation email sent successfully')

                return res.status(200).json({
                    success: true,
                    needs_activation: true,
                    message: "Activation email sent. Please check your inbox."
                })

            } catch (emailError) {
                console.error('SendGrid error:', emailError)
                return res.status(500).json({
                    error: "Failed to send activation email",
                    details: emailError instanceof Error ? emailError.message : 'Unknown error'
                })
            }
        }

        // Case 1: New customer - redirect to native endpoints
        return res.status(400).json({
            error: "Use native Medusa endpoints",
            message: "For new customers, please use the 2-step registration flow",
            instructions: {
                step1: "POST /auth/customer/emailpass/register with {email, password}",
                step2: "POST /store/customers with {email, first_name, last_name} and Authorization header"
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
