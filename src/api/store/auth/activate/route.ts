import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { Client } from "pg"

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const { token } = req.body as { token: string }

        if (!token) {
            return res.status(400).json({
                error: "Activation token is required"
            })
        }

        // Decode token
        const decoded = Buffer.from(token, 'base64').toString('utf-8')
        const [customerId, timestamp] = decoded.split(':')

        if (!customerId || !timestamp) {
            return res.status(400).json({
                error: "Invalid activation token"
            })
        }

        // Check token expiration (24 hours)
        const tokenAge = Date.now() - parseInt(timestamp)
        const twentyFourHours = 24 * 60 * 60 * 1000

        if (tokenAge > twentyFourHours) {
            return res.status(400).json({
                error: "Activation link has expired. Please register again."
            })
        }

        // Get customer
        const customerModule = req.scope.resolve(Modules.CUSTOMER)
        const authModule = req.scope.resolve(Modules.AUTH)

        const customer = await customerModule.retrieveCustomer(customerId, {
            relations: ["metadata"]
        })

        if (!customer) {
            return res.status(404).json({
                error: "Customer not found"
            })
        }

        // Verify this is a legacy customer
        if (!customer.metadata?.legacy_customer) {
            return res.status(400).json({
                error: "Invalid activation request"
            })
        }

        // Get the pre-hashed password from metadata
        const hashedPassword = customer.metadata.temporary_password_hash as string | undefined

        if (!hashedPassword) {
            return res.status(400).json({
                error: "Activation data not found. Please register again."
            })
        }

        // Create Auth Identity with the saved hashed password
        await authModule.createAuthIdentities({
            provider_identities: [{
                entity_id: customer.email!,
                provider: "emailpass",
                user_metadata: { password: hashedPassword }
            }]
        })

        // Update customer: set has_account = true, remove temporary data
        const updatedMetadata = { ...customer.metadata }
        delete updatedMetadata.legacy_customer
        delete updatedMetadata.temporary_password_hash
        delete updatedMetadata.activation_token
        delete updatedMetadata.activation_expires
        updatedMetadata.activated_at = new Date().toISOString()

        await customerModule.updateCustomers(customerId, {
            metadata: updatedMetadata
        })

        // Update has_account flag using direct pg connection
        const pgClient = new Client({
            connectionString: process.env.DATABASE_URL
        })

        try {
            await pgClient.connect()
            await pgClient.query(
                `UPDATE customer SET has_account = true WHERE id = $1`,
                [customerId]
            )
        } finally {
            await pgClient.end()
        }

        // Create session for auto-login
        const authIdentity = await authModule.retrieveAuthIdentity({
            entity_id: customer.email!,
            provider: "emailpass"
        })

        if (authIdentity) {
            // Set auth identity in session
            req.session.auth_context = {
                actor_id: authIdentity.id,
                actor_type: "customer",
                auth_identity_id: authIdentity.id
            }
        }

        return res.status(200).json({
            success: true,
            message: "Account activated successfully! Redirecting...",
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            }
        })

    } catch (error: any) {
        console.error('Activation error:', error)
        return res.status(500).json({
            error: "Activation failed. Please try again."
        })
    }
}
