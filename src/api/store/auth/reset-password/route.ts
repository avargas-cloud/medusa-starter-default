import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/utils"
import crypto from "crypto"
import { buildPasswordResetEmail } from "../../../../utils/email-templates"
import { sendMail } from "../../../../utils/mailer"

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
        console.log('🔍 Step 5: Sending email via mailer...')
        try {
            const resetLink = `${process.env.STOREFRONT_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`
            console.log('   Reset link:', resetLink)

            await sendMail({
                to: email,
                subject: "Reset Your Password – EcoPowerTech",
                html: buildPasswordResetEmail(customer.first_name || '', resetLink),
            })
            console.log('✅ ✅ ✅ Password reset email sent successfully!')

        } catch (emailError: any) {
            console.error('❌ ❌ ❌ MAILER ERROR:')
            console.error('   Error message:', emailError.message)
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
