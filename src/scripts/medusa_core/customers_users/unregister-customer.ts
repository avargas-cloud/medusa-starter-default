import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function unregisterCustomer() {
    const email = 'a.vargas@ecopowertech.com'

    console.log(`🔄 Converting ${email} to legacy (unregistered) state...`)

    try {
        // Step 1: Get customer
        const [customer] = await sql`
            SELECT * FROM customer WHERE email = ${email}
        `

        if (!customer) {
            console.log('❌ Customer not found')
            await sql.end()
            return
        }

        console.log('✅ Customer found:', customer.id)

        // Step 2: Delete auth_identity and provider_identity
        console.log('🗑️  Deleting auth data...')

        await sql`
            DELETE FROM provider_identity
            WHERE entity_id = ${email}
        `

        await sql`
            DELETE FROM auth_identity
            WHERE app_metadata->>'customer_id' = ${customer.id}
        `

        console.log('✅ Auth data deleted')

        // Step 3: Update customer to legacy state
        console.log('🔄 Setting customer to legacy state...')

        await sql`
            UPDATE customer
            SET 
                has_account = false,
                metadata = ${customer.metadata || {}}::jsonb || ${{
                legacy_customer: true,
                unregistered_at: new Date().toISOString()
            }}::jsonb
            WHERE id = ${customer.id}
        `

        console.log('✅ Customer converted to legacy state')
        console.log('\n📋 Customer state:')
        console.log('  - has_account: false')
        console.log('  - legacy_customer: true')
        console.log('  - No auth_identity (can receive activation email)')

        console.log('\n📝 Now test Case 3 with:')
        console.log(`curl -X POST http://localhost:9000/store/auth/register \\
  -H "Content-Type: application/json" \\
  -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" \\
  -d '{
    "email": "${email}",
    "password": "NewPassword123!",
    "first_name": "Alejandro",
    "last_name": "Vargas"
  }'`)

    } catch (error) {
        console.error('❌ Error:', error)
    } finally {
        await sql.end()
    }
}

unregisterCustomer()
