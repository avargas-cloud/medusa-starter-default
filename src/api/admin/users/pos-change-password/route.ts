import type {
    AuthenticatedMedusaRequest,
    MedusaResponse,
} from "@medusajs/framework/http"
import { Modules } from "@medusajs/utils"
import postgres from "postgres"

/**
 * POST /admin/users/pos-change-password
 *
 * Authenticated endpoint (admin Bearer JWT required — Medusa handles auth via
 * its default admin middleware before this handler runs).
 *
 * Verifies the current password, then updates it using the SQL-surgery
 * approach (same as /store/users/pos-reset-confirm):
 *
 *  1. Get auth_identity_id from req.auth_context (set by Medusa's middleware)
 *  2. Resolve email via provider_identity WHERE auth_identity_id = $1
 *  3. Verify current_password via authModule.authenticate()
 *  4. Delete old provider_identity
 *  5. authModule.register() → fresh auth_identity + hashed provider_identity
 *  6. Move new provider_identity → existing auth_identity (SQL UPDATE)
 *  7. Delete temp auth_identity
 *
 * WHY SQL SURGERY: see pos-reset-confirm/route.ts — authModule.updateProvider()
 * has a Medusa v2 bug creating duplicate provider_identities.
 * TODO(medusa-upgrade): re-evaluate when updateProvider() is fixed upstream.
 *
 * Body: { current_password: string, new_password: string }
 */
export async function POST(
    req: AuthenticatedMedusaRequest<{ current_password?: string; new_password?: string }>,
    res: MedusaResponse
) {
    const { current_password, new_password } = req.body

    if (!current_password || !new_password) {
        return res.status(400).json({ error: "current_password and new_password are required" })
    }

    if (new_password.length < 8) {
        return res.status(400).json({ error: "New password must be at least 8 characters" })
    }

    if (current_password === new_password) {
        return res.status(400).json({ error: "New password must be different from current password" })
    }

    const logger = req.scope.resolve("logger") as any
    const authIdentityId = req.auth_context.auth_identity_id

    if (!authIdentityId) {
        return res.status(401).json({ error: "Unauthorized" })
    }

    const sql = postgres(process.env.DATABASE_URL!)
    const authModule = req.scope.resolve(Modules.AUTH) as any

    try {
        // ── Step 1: Get email from provider_identity via auth_identity_id ──
        const [providerRow] = await sql`
            SELECT entity_id
            FROM provider_identity
            WHERE auth_identity_id = ${authIdentityId}
            AND provider = 'emailpass'
            LIMIT 1
        `

        if (!providerRow) {
            await sql.end()
            return res.status(400).json({ error: "No password account found for this user" })
        }

        const email = providerRow.entity_id as string

        // ── Step 2: Verify current password ───────────────────────────────
        const authResult = await authModule.authenticate("emailpass", {
            body: { email, password: current_password },
        } as any)

        if (!authResult?.success) {
            await sql.end()
            return res.status(401).json({ error: "Current password is incorrect" })
        }

        // ── Steps 3–7: SQL surgery (same pattern as pos-reset-confirm) ─────
        const providers = await sql`
            SELECT pi.id as provider_id, pi.auth_identity_id,
                   ai.app_metadata
            FROM provider_identity pi
            JOIN auth_identity ai ON ai.id = pi.auth_identity_id
            WHERE pi.entity_id = ${email}
            AND pi.provider = 'emailpass'
            ORDER BY (ai.app_metadata->>'user_id' IS NOT NULL) DESC,
                     pi.created_at ASC
        `

        const existingProvider = (providers.find(
            (p: any) => p.app_metadata?.user_id
        ) ?? providers[0]) as { provider_id: string; auth_identity_id: string; app_metadata: any }

        if (!existingProvider) {
            await sql.end()
            return res.status(500).json({ error: "Failed to update password" })
        }

        const existingAuthIdentityId = existingProvider.auth_identity_id

        // Clean up zombie provider_identities
        const zombieIds = providers
            .filter((p: any) => p.provider_id !== existingProvider.provider_id)
            .map((p: any) => p.provider_id as string)
        if (zombieIds.length) {
            await sql`DELETE FROM provider_identity WHERE id IN ${sql(zombieIds)}`
        }

        await sql`DELETE FROM provider_identity WHERE id = ${existingProvider.provider_id}`

        const newAuthResult = await authModule.register("emailpass", {
            body: { email, password: new_password },
        } as any)

        if (!newAuthResult?.success || !newAuthResult?.authIdentity) {
            await sql.end()
            return res.status(500).json({ error: "Password update failed during registration" })
        }

        const [newProvider] = await sql`
            SELECT id FROM provider_identity
            WHERE auth_identity_id = ${newAuthResult.authIdentity.id}
            AND provider = 'emailpass'
        `

        await sql`
            UPDATE provider_identity
            SET auth_identity_id = ${existingAuthIdentityId}
            WHERE id = ${newProvider!.id}
        `

        await sql`DELETE FROM auth_identity WHERE id = ${newAuthResult.authIdentity.id}`

        await sql.end()

        logger?.info?.(`[POS-CHANGE-PW] ✅ Password changed for ${email}`)
        return res.status(200).json({ success: true })

    } catch (err: any) {
        await sql.end().catch(() => {})
        logger?.error?.(`[POS-CHANGE-PW] ❌ ${err.message}`)
        return res.status(500).json({ error: "Failed to change password. Please try again." })
    }
}
