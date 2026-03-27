import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, ContainerRegistrationKeys, generateJwtToken } from "@medusajs/utils"

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { token, password } = req.body as {
        token: string
        password: string
    }

    if (!token || !password) {
        return res.status(400).json({
            error: "Missing required fields",
            required: ["token", "password"]
        })
    }

    // Password validation
    if (password.length < 8) {
        return res.status(400).json({
            error: "Password must be at least 8 characters"
        })
    }

    try {
        const query = req.scope.resolve("query")
        const authModule = req.scope.resolve(Modules.AUTH)
        const customerModule = req.scope.resolve(Modules.CUSTOMER)
        const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)

        // ── Step 1: Find customer by reset token ──────────────────────────────
        const { data: customers } = await query.graph({
            entity: "customer",
            fields: ["id", "email", "first_name", "last_name", "has_account", "metadata"]
        })

        const customer = customers.find((c: any) =>
            c.metadata?.reset_token === token
        )

        if (!customer) {
            return res.status(400).json({
                error: "Invalid or expired reset token"
            })
        }

        // ── Step 2: Check token expiry (reset_expires stored as ISO string) ───
        const resetExpiresRaw = customer.metadata?.reset_expires as string | undefined
        const resetExpiresMs = resetExpiresRaw ? new Date(resetExpiresRaw as string).getTime() : 0
        if (!resetExpiresMs || Date.now() > resetExpiresMs) {
            const cleanMetadata = { ...customer.metadata }
            delete cleanMetadata.reset_token
            delete cleanMetadata.reset_expires
            await customerModule.updateCustomers(customer.id, {
                metadata: cleanMetadata
            })
            return res.status(400).json({
                error: "Reset token has expired",
                message: "Please request a new password reset link."
            })
        }

        // ── Step 3: Find auth_identity for this customer ──────────────────────
        const identities = await authModule.listAuthIdentities()
        const matchingIdentity = identities.find((identity: any) =>
            identity.app_metadata?.customer_id === customer.id
        )

        if (!matchingIdentity) {
            return res.status(404).json({
                error: "Authentication identity not found"
            })
        }

        // ── Step 4: Find emailpass provider_identity ──────────────────────────
        const providerIdentities = await (authModule as any).listProviderIdentities({
            auth_identity_id: matchingIdentity.id,
            provider: "emailpass"
        })

        const emailpassProvider = providerIdentities[0] as any

        if (!emailpassProvider) {
            return res.status(404).json({
                error: "Email/password authentication not found for this account"
            })
        }

        // ── Step 5: GOLD STANDARD — Hash password with scrypt-kdf ────────────
        // Medusa v2 uses scrypt-kdf (NOT bcrypt). Named export { kdf }.
        const { kdf } = await import('scrypt-kdf')
        const hashConfig = { logN: 15, r: 8, p: 1 }
        const passwordHashBuffer = await kdf(password, hashConfig)
        const passwordHash = Buffer.from(passwordHashBuffer).toString('base64')

        // ── Step 6: Update provider_metadata.password in place ────────────────
        // No SQL surgery. No deletion. No register(). Just update in place.
        await authModule.updateProviderIdentities([{
            id: emailpassProvider.id,
            provider_metadata: {
                password: passwordHash  // Field MUST be "password", NOT "password_hash"
            }
        }])

        // ── Step 7: Invalidate reset token ────────────────────────────────────
        const cleanMetadata = { ...customer.metadata }
        delete cleanMetadata.reset_token
        delete cleanMetadata.reset_expires
        cleanMetadata.password_reset_at = new Date().toISOString()

        await customerModule.updateCustomers(customer.id, {
            metadata: cleanMetadata
        })

        console.log(`✅ Password reset successful for ${customer.email}`)

        // ── Step 8: Generate JWT for auto-login ───────────────────────────────
        const { http } = config.projectConfig
        const jwtToken = generateJwtToken({
            actor_id: customer.id,
            actor_type: "customer",
            auth_identity_id: matchingIdentity.id,
            app_metadata: {
                customer_id: customer.id
            }
        }, {
            secret: http.jwtSecret,
            expiresIn: http.jwtExpiresIn,
            jwtOptions: http.jwtOptions
        })

        return res.status(200).json({
            success: true,
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            },
            token: jwtToken,
            message: "Password reset successfully! You are now logged in."
        })

    } catch (error: any) {
        console.error('Reset password confirm error:', error)
        return res.status(500).json({
            error: "Password reset failed",
            details: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}
