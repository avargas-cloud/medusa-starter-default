import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

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
        const customerModule = req.scope.resolve("customerModuleService") as any

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
        const resetExpires = customer.metadata?.reset_expires
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
            identity.provider_identities?.some((pi: any) => pi.entity_id === customer.email)
        )

        if (!matchingIdentity) {
            return res.status(404).json({
                error: "Authentication identity not found"
            })
        }

        // Update password
        await authModule.updateAuthIdentities(matchingIdentity.id, {
            provider_identities: [{
                entity_id: customer.email,
                provider: "emailpass",
                user_metadata: { password }
            }]
        })

        // Invalidate reset token
        const cleanMetadata = { ...customer.metadata }
        delete cleanMetadata.reset_token
        delete cleanMetadata.reset_expires
        cleanMetadata.password_reset_at = new Date().toISOString()

        await customerModule.updateCustomers(customer.id, {
            metadata: cleanMetadata
        })

        console.log(`✅ Password reset successful for ${customer.email}`)

        return res.status(200).json({
            success: true,
            message: "Password reset successfully! You can now login with your new password."
        })

    } catch (error: any) {
        console.error('Reset password confirm error:', error)
        return res.status(500).json({
            error: "Password reset failed",
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
}
