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
        if (existingCustomer && !existingCustomer.has_account && (existingCustomer.metadata?.legacy_customer === true || existingCustomer.metadata?.legacy_customer === "true")) {
            // Send activation email via SendGrid
            try {
                const sgMail = await import("@sendgrid/mail")
                sgMail.default.setApiKey(process.env.SENDGRID_API_KEY!)

                // Generate activation token
                const activationToken = Buffer.from(`${existingCustomer.id}:${Date.now()}`).toString('base64')
                const activationLink = `${process.env.STOREFRONT_URL || 'http://localhost:3000'}/activate?token=${activationToken}`

                const emailContent = {
                    to: email,
                    from: process.env.SENDGRID_FROM || "noreply@ecopowertech.com",
                    subject: "Activate Your Account - Ecopower Tech",
                    text: `Hi ${existingCustomer.first_name || 'Customer'},\n\nWelcome to Ecopower Tech! Please activate your account by clicking the link below:\n\n${activationLink}\n\nThis link will expire in 24 hours.\n\nBest regards,\nEcopower Tech Team`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2>Welcome to Ecopower Tech!</h2>
                            <p>Hi ${existingCustomer.first_name || 'Customer'},</p>
                            <p>We're excited to have you! Please activate your account by clicking the button below:</p>
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${activationLink}" style="background-color: #0070f3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Activate Account</a>
                            </div>
                            <p style="color: #666; font-size: 14px;">This link will expire in 24 hours.</p>
                            <p style="color: #666; font-size: 14px;">If you didn't request this, please ignore this email.</p>
                            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                            <p style="color: #999; font-size: 12px;">Ecopower Tech - Lighting Solutions</p>
                        </div>
                    `
                }

                await sgMail.default.send(emailContent)

                console.log(`✅ Activation email sent to ${email}`)

                return res.status(200).json({
                    success: true,
                    needs_activation: true,
                    message: "Activation email sent. Please check your inbox to complete registration.",
                    email: email
                })
            } catch (emailError: any) {
                console.error('SendGrid email error:', emailError)
                console.error('SendGrid error details:', emailError.response?.body)
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
