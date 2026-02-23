import { Modules, generateJwtToken, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { getSql } from '../../../../lib/db'

const ActivateSchema = z.object({
    token: z.string().min(1, "Activation token is required")
})

/**
 * POST /store/auth/activate
 * GOLD STANDARD: Uses native Medusa AuthModule for credential creation
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    console.log('🔐 Activation endpoint called')

    const sql = getSql()

    try {
        const validation = ActivateSchema.safeParse(req.body)
        if (!validation.success) {
            return res.status(400).json({
                error: "Invalid request",
                message: "Activation token is required",
                details: validation.error.errors
            })
        }

        const { token } = validation.data

        // Decode token: base64(customer_id:timestamp)
        const decoded = Buffer.from(token, 'base64').toString('utf-8')
        const [customerId, _timestamp] = decoded.split(':')

        console.log('📝 Decoded customer ID:', customerId)

        if (!customerId) {
            return res.status(400).json({
                error: "Invalid activation token"
            })
        }

        // Get customer
        const [customer] = await sql`
            SELECT id, email, first_name, last_name, has_account, metadata
            FROM customer
            WHERE id = ${customerId} AND deleted_at IS NULL
        `

        if (!customer) {
            return res.status(404).json({
                error: "Customer not found"
            })
        }

        console.log('✅ Customer found:', customer.email)

        // Parse metadata
        let rawMetadata = customer.metadata
        if (typeof rawMetadata === 'string') {
            rawMetadata = JSON.parse(rawMetadata)
        }
        if (Array.isArray(rawMetadata)) {
            rawMetadata = rawMetadata[rawMetadata.length - 1] || {}
        }

        const activationToken = rawMetadata.activation_token
        const temporaryPassword = rawMetadata.temporary_password
        const activationExpires = rawMetadata.activation_expires

        // Validate token
        if (!activationToken || activationToken !== token) {
            return res.status(400).json({
                error: "Invalid token"
            })
        }

        // Check expiration
        if (activationExpires && new Date(activationExpires) < new Date()) {
            return res.status(400).json({
                error: "Token expired"
            })
        }

        if (!temporaryPassword) {
            return res.status(400).json({
                error: "Activation data not found"
            })
        }

        console.log('🚀 Creating credentials with Medusa AuthModule...')

        // Use Medusa's native AuthModule - GOLD STANDARD
        const authModule = req.scope.resolve(Modules.AUTH)

        console.log('🔵 Registering emailpass provider...')
        const authResult = await authModule.register("emailpass", {
            body: {
                email: customer.email,
                password: temporaryPassword
            }
        } as any)

        if (!authResult.success || !authResult.authIdentity) {
            console.error('❌ Registration failed:', authResult.error)
            return res.status(500).json({
                error: "Activation failed",
                message: authResult.error || "Failed to create credentials"
            })
        }

        const authIdentityId = authResult.authIdentity.id
        console.log('✅ Auth created:', authIdentityId)

        // Link auth_identity to customer via SQL
        console.log('🔵 Linking auth to customer...')
        await sql`
            UPDATE auth_identity
            SET app_metadata = ${sql.json({ customer_id: customer.id })}
            WHERE id = ${authIdentityId}
        `
        console.log('✅ Linked')

        // Mark customer as activated
        console.log('🔵 Updating customer...')
        await sql`
            UPDATE customer
            SET 
                has_account = true,
                metadata = ${JSON.stringify({
            ...rawMetadata,
            activation_token: null,
            activation_expires: null,
            temporary_password: null,
            activated_at: new Date().toISOString()
        })}::jsonb
            WHERE id = ${customer.id}
        `
        console.log('✅ Customer activated')

        // Sync to MeiliSearch — raw SQL bypasses Medusa events so subscriber never fires
        try {
            const { MeiliSearch } = await import('meilisearch');
            const meili = new MeiliSearch({
                host: process.env.MEILISEARCH_HOST!,
                apiKey: process.env.MEILISEARCH_API_KEY!
            });
            await meili.index('customers').updateDocuments([{
                id: customer.id,
                status: 'Registered'
            }]);
            console.log('✅ MeiliSearch status updated → Registered');
        } catch (meiliError: any) {
            console.warn('⚠️  MeiliSearch sync failed (non-fatal):', (meiliError as Error).message);
        }

        // Generate JWT token
        const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
        const { http } = config.projectConfig

        const jwtToken = generateJwtToken({
            actor_id: customer.id,
            actor_type: "customer",
            auth_identity_id: authIdentityId,
            app_metadata: {
                customer_id: customer.id
            }
        }, {
            secret: http.jwtSecret,
            expiresIn: http.jwtExpiresIn,
            jwtOptions: http.jwtOptions
        })

        console.log('✅ Activation complete for:', customer.email)

        return res.status(200).json({
            success: true,
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            },
            token: jwtToken,
            message: "Account activated successfully. You are now logged in."
        })

    } catch (error) {
        console.error('❌ Activation error:', error)
        return res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}
