import { Modules, generateJwtToken, ContainerRegistrationKeys } from "@medusajs/utils"
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"

/**
 * CASE 2: Existing Customer (Non-Legacy)
 * Verifies password and auto-logs in if correct, otherwise returns 409 error
 */
export async function handleExistingCustomer(
    req: MedusaRequest,
    res: MedusaResponse,
    existingCustomer: any,
    password: string
) {
    console.log('🔄 Existing customer detected - verifying credentials')

    try {
        const authModule = req.scope.resolve(Modules.AUTH)

        // Use emailpass provider's authenticate method (native Medusa v2)
        const authResult = await authModule.authenticate("emailpass", {
            body: {
                email: existingCustomer.email,
                password
            },
            authScope: "store",
            protocol: req.protocol,
            url: req.url,
            headers: req.headers,
            query: req.query
        } as any)

        if (!authResult.success || !authResult.authIdentity) {
            // Password incorrect - return 409
            console.log('❌ Password incorrect - returning 409')
            return res.status(409).json({
                error: "Email already registered",
                message: "This email is already registered with a different password. Please use the login page instead."
            })
        }

        console.log('✅ Password verified - auto-logging in existing customer')

        const authIdentity = authResult.authIdentity

        // Generate JWT token
        const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
        const { http } = config.projectConfig

        const token = generateJwtToken({
            actor_id: existingCustomer.id,
            actor_type: "customer",
            auth_identity_id: authIdentity.id,
            app_metadata: {
                customer_id: existingCustomer.id
            }
        }, {
            secret: http.jwtSecret,
            expiresIn: http.jwtExpiresIn,
            jwtOptions: http.jwtOptions
        })

        console.log('✅ Existing customer logged in successfully')

        return res.status(200).json({
            success: true,
            customer: {
                id: existingCustomer.id,
                email: existingCustomer.email,
                first_name: existingCustomer.first_name,
                last_name: existingCustomer.last_name
            },
            token,
            message: "Login successful. Welcome back!"
        })

    } catch (error) {
        console.error('❌ Error in existing customer handler:', error)
        return res.status(500).json({
            error: "Internal server error",
            details: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}
