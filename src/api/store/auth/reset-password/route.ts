import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import crypto from "crypto"

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { email } = req.body as { email: string }

    if (!email) {
        return res.status(400).json({
            error: "Email is required"
        })
    }

    try {
        const query = req.scope.resolve("query")
        const customerModule = req.scope.resolve("customerModuleService") as any

        // Find customer
        const { data: customers } = await query.graph({
            entity: "customer",
            filters: { email },
            fields: ["id", "email", "has_account", "first_name", "metadata"]
        })

        const customer = customers?.[0]

        // SECURITY: Always return success even if email doesn't exist
        // This prevents email enumeration attacks
        if (!customer || !customer.has_account) {
            return res.status(200).json({
                success: true,
                message: "If this email exists, you will receive a password reset link shortly."
            })
        }

        // Generate secure reset token
        const resetToken = crypto.randomBytes(32).toString('hex')
        const resetExpires = Date.now() + (60 * 60 * 1000) // 1 hour

        // Store token in customer metadata
        const updatedMetadata = {
            ...customer.metadata,
            reset_token: resetToken,
            reset_expires: resetExpires
        }

        await customerModule.updateCustomers(customer.id, {
            metadata: updatedMetadata
        })

        // Send reset email
        try {
            const sgMail = await import("@sendgrid/mail")
            sgMail.default.setApiKey(process.env.SENDGRID_API_KEY!)

            const resetLink = `${process.env.STOREFRONT_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`

            const emailContent = {
                to: email,
                from: process.env.SENDGRID_FROM || "noreply@ecopowertech.com",
                subject: "Reset Your Password - Ecopower Tech",
                text: `Hi ${customer.first_name || 'there'},\n\nClick the link below to reset your password:\n\n${resetLink}\n\nThis link will expire in 1 hour.\n\nIf you didn't request this, please ignore this email.\n\nEcopower Tech Team`,
                html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Reset Your Password</h2>
            <p>Hi ${customer.first_name || 'there'},</p>
            <p>Click the button below to reset your password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #0070f3; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
            </div>
            <p style="color: #666; font-size: 14px;">This link will expire in 1 hour.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this, please ignore this email.</p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="color: #999; font-size: 12px;">Ecopower Tech - Lighting Solutions</p>
          </div>
        `
            }

            await sgMail.default.send(emailContent)
            console.log(`✅ Password reset email sent to ${email}`)

        } catch (emailError) {
            console.error('SendGrid error:', emailError)
            // Don't fail the request if email fails
        }

        return res.status(200).json({
            success: true,
            message: "If this email exists, you will receive a password reset link shortly."
        })

    } catch (error) {
        console.error('Reset password error:', error)
        // SECURITY: Return generic message even on error
        return res.status(200).json({
            success: true,
            message: "If this email exists, you will receive a password reset link shortly."
        })
    }
}
