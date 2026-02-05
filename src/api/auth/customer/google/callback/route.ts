import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import * as jwt from "jsonwebtoken"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    const authService = req.scope.resolve(Modules.AUTH)
    const query = req.scope.resolve("query")

    // Preparar datos de autenticación con tipos compatibles
    const authData = {
        url: req.url,
        headers: req.headers as Record<string, string>,
        query: req.query as Record<string, string>,
        body: req.body as Record<string, string>,
        protocol: req.protocol,
    }

    // Validar callback con Google (provider name hardcoded porque ruta es /customer/google/callback)
    const { success, error, authIdentity } = await authService.validateCallback(
        "google",
        authData
    )

    if (!success || !authIdentity) {
        throw new MedusaError(
            MedusaError.Types.UNAUTHORIZED,
            error || "Authentication failed"
        )
    }

    // 🔍 Debug: Ver estructura de authIdentity
    console.log('🔍 authIdentity completo:', JSON.stringify(authIdentity, null, 2))

    // El email está en provider_identities[0].user_metadata.email
    const googleEmail = (authIdentity as any).provider_identities?.[0]?.user_metadata?.email

    console.log('📧 Email extraído:', googleEmail)

    if (!googleEmail) {
        console.error('❌ authIdentity:', authIdentity)
        throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "Google email not found in auth response"
        )
    }

    // Buscar customer existente por email
    const { data: customers } = await query.graph({
        entity: "customer",
        filters: { email: googleEmail },
        fields: ["id", "email", "has_account", "metadata"]
    })

    let customer = customers?.[0]

    // CASO 3: Legacy Customer (QuickBooks) - Vincular Google y activar
    if (customer && customer.metadata?.legacy_customer === true && !customer.has_account) {
        console.log(`🎯 CASO 3: Legacy customer ${googleEmail} autenticado con Google - Activando...`)

        // Actualizar customer: activar cuenta y limpiar metadata de legacy
        const postgres = await import('postgres')
        const sql = postgres.default(process.env.DATABASE_URL!)

        await sql`
      UPDATE customer
      SET 
        has_account = true,
        metadata = metadata - 'legacy_customer' - 'temporary_password' - 'activation_token' - 'activation_expires'
      WHERE id = ${customer.id}
    `

        console.log(`✅ Legacy customer activado: ${googleEmail}`)
        await sql.end()
    }

    // CASO 2: Cliente existente normal - ya está autenticado, solo login
    else if (customer && customer.has_account) {
        console.log(`✅ CASO 2: Cliente existente ${googleEmail} - Login normal`)
    }

    // CASO 1: Cliente nuevo - Buscar customer recién creado por Google Auth Module
    else if (!customer) {
        console.log(`✨ CASO 1: Nuevo cliente ${googleEmail} - Buscando customer creado por Auth Module...`)

        // El Auth Module crea el customer automáticamente, busquémoslo de nuevo
        // con un pequeño delay para asegurar que la transacción se completó
        await new Promise(resolve => setTimeout(resolve, 100))

        const { data: newCustomers } = await query.graph({
            entity: "customer",
            filters: { email: googleEmail },
            fields: ["id", "email", "has_account", "metadata"]
        })

        customer = newCustomers?.[0]

        if (!customer) {
            throw new MedusaError(
                MedusaError.Types.NOT_FOUND,
                `Customer not found after Google OAuth for email: ${googleEmail}`
            )
        }

        console.log(`✅ Customer encontrado: ${customer.id}`)
    }

    // Generar JWT token
    const { http } = config.projectConfig

    if (!http.jwtSecret) {
        throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "JWT secret not configured"
        )
    }

    // CRITICAL: actor_id MUST be the customer.id, not authIdentity.id
    const tokenData: any = {
        actor_id: customer.id,      // ← Customer ID (NOT authIdentity.id)
        actor_type: "customer",
        auth_identity_id: authIdentity.id,  // ← Auth Identity ID
        app_metadata: {
            customer_id: customer.id, // ← Customer ID for linking
            provider: "google",
        },
    }

    console.log('[Google OAuth Callback] Generating JWT for customer:', customer.id);

    // Type assertion to bypass Railway TypeScript strictness
    const token = (jwt.sign as any)(tokenData, http.jwtSecret, {
        expiresIn: http.jwtExpiresIn || "24h",
    })

    // 🔥 Redirigir al frontend con el token (FIXED)
    const frontendCallbackUrl = `${process.env.STOREFRONT_URL || 'http://localhost:4321'}/auth/callback?token=${token}`;

    console.log('[Google OAuth Callback] Redirecting to:', frontendCallbackUrl);

    return res.redirect(frontendCallbackUrl)
}

export const POST = GET
