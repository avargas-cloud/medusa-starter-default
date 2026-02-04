import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import jwt, { Secret } from "jsonwebtoken"

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

    const existingCustomer = customers?.[0]

    // CASO 3: Legacy Customer (QuickBooks) - Vincular Google y activar
    if (existingCustomer && existingCustomer.metadata?.legacy_customer === true && !existingCustomer.has_account) {
        console.log(`🎯 CASO 3: Legacy customer ${googleEmail} autenticado con Google - Activando...`)

        // Actualizar customer: activar cuenta y limpiar metadata de legacy
        const postgres = await import('postgres')
        const sql = postgres.default(process.env.DATABASE_URL!)

        await sql`
      UPDATE customer
      SET 
        has_account = true,
        metadata = metadata - 'legacy_customer' - 'temporary_password' - 'activation_token' - 'activation_expires'
      WHERE id = ${existingCustomer.id}
    `

        console.log(`✅ Legacy customer activado: ${googleEmail}`)
        await sql.end()
    }

    // CASO 2: Cliente existente normal - ya está autenticado, solo login
    else if (existingCustomer && existingCustomer.has_account) {
        console.log(`✅ CASO 2: Cliente existente ${googleEmail} - Login normal`)
    }

    // CASO 1: Cliente nuevo - Google OAuth ya lo creó automáticamente
    else if (!existingCustomer) {
        console.log(`✨ CASO 1: Nuevo cliente ${googleEmail} - Creado por Google OAuth`)
    }

    // Generar JWT token
    const { http } = config.projectConfig

    if (!http.jwtSecret) {
        throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "JWT secret not configured"
        )
    }

    // Extraer valores con tipo específico
    const jwtSecret: Secret = http.jwtSecret
    const jwtExpiresIn: string = http.jwtExpiresIn || "24h"

    const tokenData = {
        actor_id: authIdentity.id,
        actor_type: "customer",
        auth_identity_id: authIdentity.id,
        app_metadata: {
            provider: "google",
        },
    }

    const token = jwt.sign(tokenData, jwtSecret, {
        expiresIn: jwtExpiresIn,
    })

    // 🔥 Redirigir al frontend con el token
    const returnTo = (req.query.returnTo as string) ||
        process.env.STORE_URL ||
        "http://localhost:4321/account"

    const redirectUrl = new URL(returnTo)
    redirectUrl.searchParams.set("token", token)

    return res.redirect(redirectUrl.toString())
}

export const POST = GET
