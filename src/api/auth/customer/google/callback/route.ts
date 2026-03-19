import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, ContainerRegistrationKeys, MedusaError } from "@medusajs/utils"
import * as jwt from "jsonwebtoken"

export async function GET(req: MedusaRequest, res: MedusaResponse) {
    console.log('\n\n======================================================');
    console.log('🚨 [GOOGLE OAUTH CALLBACK] REQUEST RECEIVED 🚨');
    console.log('======================================================');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Method:', req.method);
    console.log('URL:', req.url);

    // Loguear que estamos recibiendo la petición para diagnosticar si Medusa
    // la intercepta o si efectivamente llega a nuestro handler custom.
    const safeQuery = req.query || {};
    console.log('Query parameters present:', Object.keys(safeQuery));
    if ((safeQuery as any).error) {
        console.log('⚠️ GOOGLE RETURNED ERROR IN QUERY:', (safeQuery as any).error);
    }
    console.log('======================================================\n\n');

    const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    const authService = req.scope.resolve(Modules.AUTH)
    const query = req.scope.resolve("query")

    // Preparar datos de autenticación con tipos compatibles
    const authData = {
        url: req.url,
        headers: req.headers as Record<string, string>,
        query: req.query as Record<string, string>,
        body: req.body as Record<string, string>,
        // Railway terminates SSL, so req.protocol sees 'http'. 
        // We must force 'https' in production to match the registered redirect_uri.
        protocol: process.env.NODE_ENV === 'production' ? 'https' : req.protocol,
        host: req.headers.host, // CRITICAL: Railway needs explicit host for redirect_uri validation
    }

    // 🔍 DEBUG: Log crítico para diagnosticar producción
    console.log('[GOOGLE OAUTH CALLBACK] Starting validation...');
    console.log('  Environment:', process.env.NODE_ENV);
    console.log('  Protocol:', authData.protocol);
    console.log('  Host:', authData.host);
    console.log('  Full URL:', req.url);
    console.log('  Query params:', Object.keys(req.query).join(', '));
    console.log('  Has code:', !!req.query.code);
    console.log('  Has state:', !!req.query.state);

    // Validar callback con Google (provider name hardcoded porque ruta es /customer/google/callback)
    const { success, error, authIdentity } = await authService.validateCallback(
        "google",
        authData
    )

    if (!success || !authIdentity) {
        console.error('[GOOGLE OAUTH CALLBACK] ❌ Validation FAILED');
        console.error('  Success:', success);
        console.error('  Error:', error);
        console.error('  AuthIdentity:', authIdentity);
        throw new MedusaError(
            MedusaError.Types.UNAUTHORIZED,
            error || "Authentication failed"
        )
    }

    console.log('[GOOGLE OAUTH CALLBACK] ✅ Validation SUCCESS');


    // El email está en provider_identities[0].user_metadata.email
    const googleEmail = (authIdentity as any).provider_identities?.[0]?.user_metadata?.email

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

    if (customer && customer.metadata?.legacy_customer === true && !customer.has_account) {

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
        // CRITICAL FIX: Link the auth_identity to this customer in the DB!
        // Optimized to only write if the link doesn't already exist or is different
        await sql`
      UPDATE auth_identity
      SET app_metadata = jsonb_set(COALESCE(app_metadata, '{}'::jsonb), '{customer_id}', to_jsonb(${customer.id}::text))
      WHERE id = ${authIdentity.id} 
        AND (app_metadata->>'customer_id' IS NULL OR app_metadata->>'customer_id' != ${customer.id})
    `
        await sql.end()
    }

    else if (customer && customer.has_account) {
        // Just link the auth identity in case it's a new login or previous linking failed
        const postgres = await import('postgres')
        const sql = postgres.default(process.env.DATABASE_URL!)
        await sql`
      UPDATE auth_identity
      SET app_metadata = jsonb_set(COALESCE(app_metadata, '{}'::jsonb), '{customer_id}', to_jsonb(${customer.id}::text))
      WHERE id = ${authIdentity.id} 
        AND (app_metadata->>'customer_id' IS NULL OR app_metadata->>'customer_id' != ${customer.id})
    `
        await sql.end()
    }

    else if (!customer) {

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

        // Link the auth_identity to the newly created customer
        const postgres = await import('postgres')
        const sql = postgres.default(process.env.DATABASE_URL!)
        await sql`
      UPDATE auth_identity
      SET app_metadata = jsonb_set(COALESCE(app_metadata, '{}'::jsonb), '{customer_id}', to_jsonb(${customer.id}::text))
      WHERE id = ${authIdentity.id} 
        AND (app_metadata->>'customer_id' IS NULL OR app_metadata->>'customer_id' != ${customer.id})
    `
        await sql.end()
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

    // Type assertion to bypass Railway TypeScript strictness
    const token = (jwt.sign as any)(tokenData, http.jwtSecret, {
        expiresIn: http.jwtExpiresIn || "24h",
    })

    // 🔥 Redirigir al frontend con el token (FIXED)
    const storefrontUrl = process.env.STOREFRONT_URL || (process.env.NODE_ENV === 'production' ? 'https://ecopowertech-headless-medusa.vercel.app' : 'http://localhost:4321');
    const frontendCallbackUrl = `${storefrontUrl}/auth/callback?token=${token}`;

    return res.redirect(frontendCallbackUrl)
}

export const POST = GET
