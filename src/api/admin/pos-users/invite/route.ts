/**
 * src/api/admin/pos-users/invite/route.ts
 * POST /admin/pos-users/invite
 *
 * Creates a pos_user record and sends an invite email.
 * Auth identity is created LATER when the user activates their account (/activate page).
 * This avoids circular HTTP calls from backend to itself.
 */

import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import sgMail from '@sendgrid/mail'
import jwt from 'jsonwebtoken'
import { POS_USER_MODULE } from '../../../../modules/pos-user'
import { buildActivationEmail } from '../../../../utils/email-templates'

type InviteBody = {
    email: string
    first_name?: string
    last_name?: string
}

export async function POST(
    req: AuthenticatedMedusaRequest<InviteBody>,
    res: MedusaResponse
) {
    const { email, first_name, last_name } = req.body
    const logger = req.scope.resolve('logger') as any
    const POS_URL = process.env.POS_URL || 'https://pos.ecopowertech.com'
    const JWT_SECRET = process.env.JWT_SECRET || 'supersecret'

    if (!email) return res.status(400).json({ error: 'email is required' })

    try {
        const posUserService = req.scope.resolve(POS_USER_MODULE) as any

        // ── Create or find existing pos_user record ─────────────────────────────
        let posUser: any
        const [existing] = await posUserService.listPosUsers({ email })

        if (existing) {
            logger?.info?.(`[POS-INVITE] Re-inviting existing user ${email}`)
            // Update name if provided
            if (first_name || last_name) {
                const [updated] = await posUserService.updatePosUsers([{
                    id: existing.id,
                    first_name: first_name ?? existing.first_name,
                    last_name: last_name ?? existing.last_name,
                }])
                posUser = updated
            } else {
                posUser = existing
            }
        } else {
            posUser = await posUserService.createPosUsers({
                email,
                first_name: first_name || null,
                last_name: last_name || null,
            })
            logger?.info?.(`[POS-INVITE] Created pos_user ${posUser.id} for ${email}`)
        }

        // ── Sign invite JWT (48h) ──────────────────────────────────────────────
        // pos_user_id is included so /activate can link auth identity on activation
        const inviteToken = jwt.sign(
            {
                email,
                pos_user_id: posUser.id,
                first_name: posUser.first_name ?? undefined,
                last_name: posUser.last_name ?? undefined,
                type: 'pos_invite',
            },
            JWT_SECRET,
            { expiresIn: '48h' }
        )

        const activateUrl = `${POS_URL}/activate?token=${encodeURIComponent(inviteToken)}`
        logger?.info?.(`[POS-INVITE] Activate URL for ${email}: ${activateUrl}`)

        // ── Send via SendGrid ──────────────────────────────────────────────────
        const apiKey = process.env.SENDGRID_API_KEY
        const from = process.env.SENDGRID_FROM || 'noreply@ecopowertech.com'
        let emailSent = false

        if (apiKey) {
            try {
                sgMail.setApiKey(apiKey)
                await sgMail.send({
                    to: email,
                    from,
                    subject: "You've been invited to EcoPowerTech POS",
                    html: buildActivationEmail(first_name || 'there', activateUrl),
                })
                logger?.info?.(`[POS-INVITE] ✅ Email sent to ${email}`)
                emailSent = true
            } catch (emailErr: any) {
                // Email failure is non-fatal — invite is still created, admin can share the link
                logger?.warn?.(`[POS-INVITE] ⚠️ SendGrid failed (${emailErr?.message}). Returning activate_url.`)
            }
        } else {
            logger?.warn?.('[POS-INVITE] No SENDGRID_API_KEY — email skipped')
        }

        return res.status(201).json({
            success: true,
            // Always return activate_url if email wasn't sent (dev mode OR SendGrid error)
            ...(!emailSent ? { activate_url: activateUrl } : {}),
        })

    } catch (err: any) {
        logger?.error?.(`[POS-INVITE] ❌ ${err.message}`)
        return res.status(500).json({ error: err.message })
    }
}
