import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import postgres from "postgres"

/**
 * GET /store/customers/me/auth-methods
 * 
 * Returns authentication methods available for the current customer
 * Used by frontend to determine:
 * - If user logged in with Google
 * - If user has password set
 * - Which auth providers are linked
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        // Get authenticated customer from context
        const customerId = (req as any).auth?.actor_id

        if (!customerId) {
            return res.status(401).json({
                error: "Unauthorized",
                message: "Authentication required"
            })
        }

        const sql = postgres(process.env.DATABASE_URL!)

        try {
            // Get all provider_identities for this customer
            const providers = await sql`
                SELECT DISTINCT pi.provider
                FROM provider_identity pi
                JOIN auth_identity ai ON ai.id = pi.auth_identity_id
                WHERE ai.app_metadata->>'customer_id' = ${customerId}
            `

            // Extract provider names
            const providerList = providers.map(p => p.provider)

            // Determine if user has password
            const hasPassword = providerList.includes('emailpass')

            // Determine if user has Google
            const hasGoogle = providerList.includes('google')

            await sql.end()

            return res.status(200).json({
                providers: providerList,
                has_password: hasPassword,
                has_google: hasGoogle
            })

        } catch (dbError) {
            console.error('❌ Database error:', dbError)
            await sql.end()
            throw dbError
        }

    } catch (error: any) {
        console.error('❌ Error fetching auth methods:', error)
        return res.status(500).json({
            error: "Internal server error",
            message: "Failed to fetch authentication methods"
        })
    }
}
