import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { handleNewCustomerRegistration } from './case1-new-customer'
import { handleExistingCustomer } from './case2-existing-customer'
import { handleLegacyCustomerActivation } from './case3-legacy-customer'

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { email, password, first_name, last_name } = req.body as {
        email: string
        password: string
        first_name: string
        last_name: string
    }

    // Validate required fields
    if (!email || !password || !first_name || !last_name) {
        return res.status(400).json({
            error: "Missing required fields",
            required: ["email", "password", "first_name", "last_name"]
        })
    }

    try {
        // Check if customer exists (using SQL to bypass cache)
        const postgres = await import('postgres')
        const sql = postgres.default(process.env.DATABASE_URL!)

        console.log('🔍 [CHECKPOINT 1] Querying customer...')
        const [existingCustomer] = await sql`
            SELECT id, email, first_name, last_name, has_account, metadata
            FROM customer
            WHERE email = ${email}
        `
        console.log('✅ [CHECKPOINT 2] Query complete')

        console.log('📝 Customer lookup:', {
            email,
            found: !!existingCustomer,
            has_account: existingCustomer?.has_account,
            is_legacy: existingCustomer?.metadata?.legacy_customer
        })

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // CASE 2: Email already registered (has account)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (existingCustomer && existingCustomer.has_account) {
            return handleExistingCustomer(req, res, existingCustomer, password)
        }

        // CASE 3: Legacy customer (exists but no account)
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (existingCustomer && !existingCustomer.has_account) {
            // Parse metadata if it's a string
            let metadata = existingCustomer.metadata
            if (typeof metadata === 'string') {
                try {
                    metadata = JSON.parse(metadata)
                } catch {
                    metadata = {}
                }
            }

            // Check if metadata has legacy_customer flag
            let isLegacy = false

            if (Array.isArray(metadata)) {
                // Handle array format
                isLegacy = metadata.some((item: any) => {
                    if (typeof item === 'string') {
                        try {
                            const parsed = JSON.parse(item)
                            return parsed.legacy_customer === true || parsed.legacy_customer === 'true'
                        } catch {
                            return false
                        }
                    }
                    return item?.legacy_customer === true || item?.legacy_customer === 'true'
                })
            } else if (typeof metadata === 'object' && metadata !== null) {
                // Handle object format
                isLegacy = metadata.legacy_customer === true || metadata.legacy_customer === 'true'
            }

            console.log('🎯 Legacy customer -', isLegacy ? 'sending activation email' : 'not legacy')

            if (isLegacy) {
                return handleLegacyCustomerActivation(req, res, existingCustomer, password)
            }
        }

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // CASE 1: New customer
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        return handleNewCustomerRegistration(req, res, { email, password, first_name, last_name })

    } catch (error) {
        console.error('Registration error:', error)
        return res.status(500).json({
            error: "Registration failed",
            details: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}
