/**
 * POST /admin/users/send-reset-password
 *
 * Admin-only endpoint to trigger a password reset email for any user.
 * Bypasses Medusa's native notification flow (which requires SendGrid template IDs)
 * and sends the email directly with our custom branded template.
 *
 * Body: { email: string }
 * Auth: requires valid admin JWT
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/utils"
import { buildPasswordResetEmail } from "../../../../utils/email-templates"
import { sendMail } from "../../../../utils/mailer"

const ADMIN_URL = process.env.MEDUSA_BACKEND_URL || "https://medusa-starter-default-production-b69e.up.railway.app"

export async function POST(req: MedusaRequest, res: MedusaResponse) {
    const { email } = req.body as { email?: string }

    if (!email || typeof email !== "string") {
        return res.status(400).json({ error: "email is required" })
    }

    try {
        // 1. Get auth module to generate reset token
        const authModule = req.scope.resolve(Modules.AUTH) as any

        let token: string
        try {
            // Medusa v2 auth module — generateResetPasswordToken
            token = await authModule.generateResetPasswordToken(
                "user",        // actorType
                "emailpass",   // provider
                email          // entity_id
            )
        } catch (authErr: any) {
            req.scope.resolve("logger")?.warn?.(`[ResetPW] generateResetPasswordToken failed: ${authErr.message}`)
            return res.status(404).json({ error: "User not found or provider not available" })
        }

        // 2. Build reset link
        const resetUrl = `${ADMIN_URL}/app/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`

        // 3. Send email via mailer
        const html = buildPasswordResetEmail("", resetUrl)

        await sendMail({
            to: email,
            subject: "Reset your EcoPowerTech password",
            html,
        })

        req.scope.resolve("logger")?.info?.(`[ResetPW] ✅ Reset email sent to ${email}`)
        return res.status(200).json({ success: true, message: `Reset email sent to ${email}` })

    } catch (err: any) {
        req.scope.resolve("logger")?.error?.(`[ResetPW] ❌ ${err.message}`)
        return res.status(500).json({ error: err.message ?? "Unexpected error" })
    }
}
