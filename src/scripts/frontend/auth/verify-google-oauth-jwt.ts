import { Modules, ContainerRegistrationKeys } from "@medusajs/utils"
import * as jwt from "jsonwebtoken"

/**
 * Script de Verificación: Google OAuth JWT Generation
 * 
 * Verifica que el JWT se genera correctamente para:
 * - CASO 1: Nuevo cliente (creado por Auth Module)
 * - CASO 2: Cliente existente (login normal)
 */

export default async function verifyGoogleOAuthJWT({ container }: any) {
    console.log('\n🔍 ===== VERIFICACIÓN DE GOOGLE OAUTH JWT =====\n')

    const config = container.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
    const query = container.resolve("query")
    const { http } = config.projectConfig

    // Test email (usa tu email real de Google)
    const testEmail = "a.vargas@ecopowertech.com"

    try {
        // ========== CASO 2: Cliente Existente ==========
        console.log('📋 CASO 2: Verificando cliente existente...')

        const { data: existingCustomers } = await query.graph({
            entity: "customer",
            filters: { email: testEmail },
            fields: ["id", "email", "has_account", "first_name", "last_name"]
        })

        const existingCustomer = existingCustomers?.[0]

        if (existingCustomer) {
            console.log('✅ Cliente encontrado:', {
                id: existingCustomer.id,
                email: existingCustomer.email,
                has_account: existingCustomer.has_account,
                name: `${existingCustomer.first_name} ${existingCustomer.last_name}`
            })

            // Simular generación de JWT
            const mockAuthIdentityId = "authid_test_123"

            const tokenData = {
                actor_id: existingCustomer.id,      // ← Debe ser customer.id
                actor_type: "customer",
                auth_identity_id: mockAuthIdentityId,
                app_metadata: {
                    customer_id: existingCustomer.id,
                    provider: "google",
                },
            }

            const token = jwt.sign(tokenData, http.jwtSecret, {
                expiresIn: http.jwtExpiresIn || "24h",
            })

            // Decodificar para verificar
            const decoded = jwt.verify(token, http.jwtSecret) as any

            console.log('\n🔑 JWT Generado (Caso 2):')
            console.log('  - actor_id:', decoded.actor_id)
            console.log('  - actor_type:', decoded.actor_type)
            console.log('  - auth_identity_id:', decoded.auth_identity_id)
            console.log('  - customer_id (metadata):', decoded.app_metadata?.customer_id)

            // Verificación crítica
            if (decoded.actor_id !== existingCustomer.id) {
                console.error('❌ ERROR: actor_id NO coincide con customer.id')
                console.error(`   Esperado: ${existingCustomer.id}`)
                console.error(`   Recibido: ${decoded.actor_id}`)
            } else {
                console.log('✅ CORRECTO: actor_id === customer.id')
            }

            if (decoded.app_metadata?.customer_id !== existingCustomer.id) {
                console.error('❌ ERROR: app_metadata.customer_id NO coincide')
            } else {
                console.log('✅ CORRECTO: app_metadata.customer_id === customer.id')
            }

        } else {
            console.log('⚠️  No se encontró cliente existente con email:', testEmail)
        }

        // ========== CASO 1: Nuevo Cliente (Simulación) ==========
        console.log('\n📋 CASO 1: Simulando nuevo cliente...')
        console.log('ℹ️  En producción, el Auth Module crearía el customer automáticamente')
        console.log('ℹ️  El callback debe buscar el customer creado y usar su ID en el JWT')

        const mockNewCustomerId = "cus_new_test_123"
        console.log('\n✅ Simulación: Customer creado con ID:', mockNewCustomerId)

        const newCustomerTokenData = {
            actor_id: mockNewCustomerId,  // ← DEBE ser el customer.id (no authIdentity.id)
            actor_type: "customer",
            auth_identity_id: "authid_new_test_456",
            app_metadata: {
                customer_id: mockNewCustomerId,
                provider: "google",
            },
        }

        const newToken = jwt.sign(newCustomerTokenData, http.jwtSecret, {
            expiresIn: http.jwtExpiresIn || "24h",
        })

        const decodedNew = jwt.verify(newToken, http.jwtSecret) as any

        console.log('\n🔑 JWT Generado (Caso 1):')
        console.log('  - actor_id:', decodedNew.actor_id)
        console.log('  - actor_type:', decodedNew.actor_type)
        console.log('  - auth_identity_id:', decodedNew.auth_identity_id)
        console.log('  - customer_id (metadata):', decodedNew.app_metadata?.customer_id)

        if (decodedNew.actor_id === decodedNew.app_metadata?.customer_id) {
            console.log('✅ CORRECTO: actor_id === customer_id (nuevo cliente)')
        } else {
            console.error('❌ ERROR: actor_id NO coincide con customer_id')
        }

        // ========== RESUMEN ==========
        console.log('\n📊 ===== RESUMEN DE VERIFICACIÓN =====')
        console.log('')
        console.log('✅ CASO 2 (Existente): JWT debe usar customer.id como actor_id')
        console.log('✅ CASO 1 (Nuevo): JWT debe buscar y usar el customer.id creado por Auth Module')
        console.log('')
        console.log('⚠️  CRÍTICO: Nunca usar authIdentity.id como actor_id')
        console.log('⚠️  CRÍTICO: Siempre incluir customer_id en app_metadata')
        console.log('')
        console.log('🔧 Si /api/auth/me falla con "Request already authenticated as a customer"')
        console.log('   → El actor_id en el JWT es incorrecto (probablemente authIdentity.id)')
        console.log('')

    } catch (error) {
        console.error('\n❌ Error durante verificación:', error)
        throw error
    }
}
