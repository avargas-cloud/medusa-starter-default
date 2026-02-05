import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, ContainerRegistrationKeys, generateJwtToken } from "@medusajs/framework/utils"
import postgres from 'postgres'

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

        // Find customer by reset token
        const { data: customers } = await query.graph({
            entity: "customer",
            fields: ["id", "email", "has_account", "metadata"]
        })

        const customer = customers.find((c: any) =>
            c.metadata?.reset_token === token
        )

        if (!customer) {
            return res.status(400).json({
                error: "Invalid or expired reset token"
            })
        }

        // Check token expiry
        const resetExpires = customer.metadata?.reset_expires as number | undefined
        if (!resetExpires || Date.now() > resetExpires) {
            // Clean up expired token
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

        // Find and update Auth Identity
        const identities = await authModule.listAuthIdentities()
        const matchingIdentity = identities.find((identity: any) =>
            identity.app_metadata?.customer_id === customer.id
        )

        if (!matchingIdentity) {
            return res.status(404).json({
                error: "Authentication identity not found"
            })
        }

        // Update password using THE SAME METHOD as account creation
        // Delete old provider_identity and create new one with register()
        try {
            console.log('🔵 Updating password with authModule.register() (same as account creation)...')

            const sql = postgres(process.env.DATABASE_URL!)

            // ✅ SECURITY: Validate new password is different from current password
            console.log('🔒 Validating new password is different from current...')
            const passwordCheckResult = await authModule.authenticate("emailpass", {
                body: {
                    email: customer.email,
                    password: password
                }
            } as any)

            if (passwordCheckResult.success) {
                console.log('❌ New password is same as current password')
                return res.status(400).json({
                    error: "Password reuse not allowed",
                    message: "Your new password cannot be the same as your current password. Please choose a different password."
                })
            }
            console.log('✅ New password is different from current')


            // Delete old provider_identity
            await sql`
                DELETE FROM provider_identity
                WHERE auth_identity_id = ${matchingIdentity.id}
                AND provider = 'emailpass'
            `
            console.log('🗑️  Deleted old provider_identity')

            // Create NEW provider_identity with hashed password using register()
            const authResult = await authModule.register("emailpass", {
                body: {
                    email: customer.email,
                    password: password
                }
            } as any)

            if (!authResult.success || !authResult.authIdentity) {
                console.error('❌ Register failed')
                return res.status(500).json({ error: "Password update failed" })
            }

            console.log('✅ New auth created with hashed password')

            // Get the new provider_identity
            const [newProvider] = await sql`
                SELECT id FROM provider_identity
                WHERE auth_identity_id = ${authResult.authIdentity.id}
                AND provider = 'emailpass'
            `

            // Move it to the existing auth_identity
            await sql`
                UPDATE provider_identity
                SET auth_identity_id = ${matchingIdentity.id}
                WHERE id = ${newProvider!.id}
            `

            // Delete the temporary auth_identity
            await sql`
                DELETE FROM auth_identity
                WHERE id = ${authResult.authIdentity.id}
            `

            console.log('✅ Password updated successfully using register() method')
            await sql.end()

        } catch (updateError: any) {
            console.error('❌ Password update error:', updateError)
            throw updateError
        }

        // Invalidate reset token
        const cleanMetadata = { ...customer.metadata }
        delete cleanMetadata.reset_token
        delete cleanMetadata.reset_expires
        cleanMetadata.password_reset_at = new Date().toISOString()

        await customerModule.updateCustomers(customer.id, {
            metadata: cleanMetadata
        })

        console.log(`✅ Password reset successful for ${customer.email}`)

        // Generate JWT token for auto-login (Gold Standard)
        // matchingIdentity already declared at line 68
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
