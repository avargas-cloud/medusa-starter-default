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
        // Decode token
        const decoded = Buffer.from(token, 'base64').toString()
        const [customerId, timestamp] = decoded.split(':')

        if (!customerId || !timestamp) {
            return res.status(400).json({
                error: "Invalid token format"
            })
        }

        // Check token expiry (24 hours)
        const tokenAge = Date.now() - parseInt(timestamp)
        const maxAge = 24 * 60 * 60 * 1000 // 24 hours

        if (tokenAge > maxAge) {
            return res.status(400).json({
                error: "Token expired",
                message: "Activation link has expired. Please request a new one."
            })
        }

        const query = req.scope.resolve("query")
        const authModule = req.scope.resolve(Modules.AUTH)
        const customerModule = req.scope.resolve(Modules.CUSTOMER)

        // Find customer
        const { data: customers } = await query.graph({
            entity: "customer",
            filters: { id: customerId },
            fields: ["id", "email", "has_account", "metadata", "first_name", "last_name"]
        })

        const customer = customers?.[0]

        if (!customer) {
            return res.status(404).json({
                error: "Customer not found"
            })
        }

        // Verify customer is legacy (hasn't been activated yet)
        if (customer.has_account) {
            return res.status(400).json({
                error: "Account already activated",
                message: "This account has already been activated. Please login instead."
            })
        }

        if (!customer.metadata?.legacy_customer) {
            return res.status(400).json({
                error: "Invalid activation request"
            })
        }

        // Create Auth Identity  
        const authIdentity = await authModule.createAuthIdentities({
            provider_identities: [{
                entity_id: customer.email!,
                provider: "emailpass",
                user_metadata: { password }
            }]
        })

        // Update customer: set has_account = true, remove legacy flag
        const updatedMetadata = { ...customer.metadata }
        delete updatedMetadata.legacy_customer
        updatedMetadata.activated_at = new Date().toISOString()

        await customerModule.updateCustomers(customerId, {
            metadata: updatedMetadata
        })

        // Update has_account field directly (customerModule doesn't support this field)
        const { Client } = await import('pg')
        const dbClient = new Client({ connectionString: process.env.DATABASE_URL })

        try {
            await dbClient.connect()
            await dbClient.query('UPDATE customer SET has_account = true WHERE id = $1', [customerId])
        } finally {
            await dbClient.end()
        }

        console.log(`Customer ${customer.email} activated successfully`)

        return res.status(200).json({
            success: true,
            message: "Account activated successfully! You can now login.",
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            }
        })

    } catch (error: any) {
        console.error('Activation error:', error)

        if (error.message?.includes('already exists')) {
            return res.status(409).json({
                error: "Email already has authentication credentials",
                message: "This email is already registered. Please login instead."
            })
        }

        return res.status(500).json({
            error: "Activation failed",
            details: error instanceof Error ? error.message : 'Unknown error'
        })
    }
}
