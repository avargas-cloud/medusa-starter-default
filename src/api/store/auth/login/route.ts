import { Modules, generateJwtToken, ContainerRegistrationKeys } from "@medusajs/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"

const LoginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1)
})

/**
 * Custom Login Endpoint for Customers
 * POST /store/auth/login
 * 
 * Uses Medusa v2's native emailpass provider authenticate method
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
) {
    try {
        const { email, password } = LoginSchema.parse(req.body)

        console.log('🔐 Login attempt for:', email)

        const authModule = req.scope.resolve(Modules.AUTH)

        // Use emailpass provider's authenticate method (native Medusa v2)
        const authResult = await authModule.authenticate("emailpass", {
            body: { email, password },
            authScope: "store",
            protocol: req.protocol,
            url: req.url,
            headers: req.headers,
            query: req.query
        } as any)

        if (!authResult.success || !authResult.authIdentity) {
            console.log('❌ Login failed:', authResult.error)
            return res.status(401).json({
                error: "Invalid credentials",
                message: authResult.error || "Email or password is incorrect"
            })
        }

        console.log('✅ Authentication successful')

        const authIdentity = authResult.authIdentity

        // Get customer ID from auth identity
        const customerId = authIdentity.app_metadata?.customer_id as string

        console.log('📝 Auth Identity ID:', authIdentity.id)
        console.log('📝 Auth Identity app_metadata:', JSON.stringify(authIdentity.app_metadata))
        console.log('📝 Customer ID from metadata:', customerId)

        if (!customerId) {
            console.log('❌ No customer linked to this auth identity')
            return res.status(401).json({
                error: "Account not found",
                message: "This account is not properly configured. Please contact support."
            })
        }

        // Get customer details using SQL (customerModule doesn't work in store scope)
        const postgres = await import('postgres')
        const sql = postgres.default(process.env.DATABASE_URL!)

        let customer
        const [result] = await sql`
            SELECT id, email, first_name, last_name
            FROM customer
            WHERE id = ${customerId} AND deleted_at IS NULL
        `
        customer = result

        if (!customer) {
            console.log('❌ Customer not found')
            return res.status(401).json({
                error: "Account not found",
                message: "Customer account does not exist."
            })
        }

        console.log('✅ Customer found:', customer.email)

        // Generate JWT token
        const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
        const { http } = config.projectConfig

        const token = generateJwtToken({
            actor_id: customer.id,
            actor_type: "customer",
            auth_identity_id: authIdentity.id,
            app_metadata: {
                customer_id: customer.id
            }
        }, {
            secret: http.jwtSecret,
            expiresIn: http.jwtExpiresIn,
            jwtOptions: http.jwtOptions
        })

        console.log('✅ Login successful for customer:', customer.id)

        return res.status(200).json({
            success: true,
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            },
            token
        })

    } catch (error) {
        console.error('❌ Login error:', error)

        if (error instanceof z.ZodError) {
            return res.status(400).json({
                error: "Invalid request",
                message: "Email and password are required",
                details: error.errors
            })
        }

        return res.status(500).json({
            error: "Internal server error",
            message: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}
