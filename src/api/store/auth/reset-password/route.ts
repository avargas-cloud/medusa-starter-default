import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import crypto from "crypto"

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    console.log('🔐 ========================================')
    console.log('🔐 PASSWORD RESET ENDPOINT HIT')
    console.log('🔐 ========================================')
    console.log('📧 Request body:', JSON.stringify(req.body, null, 2))
    console.log('🔑 Headers:', JSON.stringify(req.headers, null, 2))

    const { email } = req.body as { email: string }

    if (!email) {
        console.log('❌ NO EMAIL PROVIDED')
        return res.status(400).json({
            error: "Email is required"
        })
    }

    console.log('📧 Email to reset:', email)

    try {
        console.log('🔍 Step 1: Resolving query and customer module...')
        const query = req.scope.resolve("query")
        const customerModule = req.scope.resolve(Modules.CUSTOMER)
        console.log('✅ Modules resolved')

        // Find customer
        console.log('🔍 Step 2: Searching for customer...')
        const { data: customers } = await query.graph({
            entity: "customer",
            filters: { email },
            fields: ["id", "email", "has_account", "first_name", "metadata"]
        })

        const customer = customers?.[0]
        console.log('📊 Customer found:', !!customer)
        if (customer) {
            console.log('   ID:', customer.id)
            console.log('   Email:', customer.email)
            console.log('   has_account:', customer.has_account)
        }

        // SECURITY: Always return success even if email doesn't exist
        // This prevents email enumeration attacks
        if (!customer || !customer.has_account) {
            console.log('⚠️  Customer not found or no account - returning success anyway (security)')
            return res.status(200).json({
                success: true,
                message: "If this email exists, you will receive a password reset link shortly."
            })
        }

        console.log('🔍 Step 3: Generating reset token...')
        // Generate secure reset token
        const resetToken = crypto.randomBytes(32).toString('hex')
        const resetExpires = new Date(Date.now() + (60 * 60 * 1000)) // 1 hour from now
        console.log('✅ Token generated (first 20 chars):', resetToken.substring(0, 20))
        console.log('⏰ Expires at:', resetExpires.toLocaleString())

        console.log('🔍 Step 4: Saving token to customer metadata...')
        // Store token in customer metadata
        const updatedMetadata = {
            ...customer.metadata,
            reset_token: resetToken,
            reset_expires: resetExpires.toISOString()  // ISO string format for proper date comparison
        }

        await customerModule.updateCustomers(customer.id, {
            metadata: updatedMetadata
        })
        console.log('✅ Token saved to database')

        // Send reset email
        console.log('🔍 Step 5: Sending email via SendGrid...')
        try {
            const sgMail = await import("@sendgrid/mail")
            console.log('   SendGrid module loaded')

            const apiKey = process.env.SENDGRID_API_KEY!
            console.log('   API Key length:', apiKey?.length)
            console.log('   API Key preview:', apiKey?.substring(0, 20) + '...')

            sgMail.default.setApiKey(apiKey)
            console.log('   API Key set')

            const resetLink = `${process.env.STOREFRONT_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`
            console.log('   Reset link:', resetLink)

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

            console.log('   Sending email to:', emailContent.to)
            console.log('   From:', emailContent.from)

            await sgMail.default.send(emailContent)
            console.log('✅ ✅ ✅ Password reset email sent successfully!')

        } catch (emailError: any) {
            console.error('❌ ❌ ❌ SENDGRID ERROR:')
            console.error('   Error code:', emailError.code)
            console.error('   Error message:', emailError.message)
            console.error('   Response body:', JSON.stringify(emailError.response?.body, null, 2))
            console.error('   Full error:', emailError)
            // Don't fail the request if email fails
        }

        console.log('🔍 Step 6: Returning success response')
        return res.status(200).json({
            success: true,
            message: "If this email exists, you will receive a password reset link shortly."
        })

    } catch (error: any) {
        console.error('❌ ❌ ❌ MAIN CATCH ERROR:')
        console.error('   Error:', error)
        console.error('   Stack:', error?.stack)
        // SECURITY: Return generic message even on error
        return res.status(200).json({
            success: true,
            message: "If this email exists, you will receive a password reset link shortly."
        })
    }
}
