import postgres from 'postgres'
import { loadEnv } from '@medusajs/framework/utils'

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function recreateCustomer() {
    const email = 'customtest_1740685200@test.com'

    console.log('🗑️  Deleting customer and auth data for:', email)

    try {
        // Delete all related data
        await sql`
            DELETE FROM provider_identity
            WHERE entity_id = ${email}
        `

        await sql`
            DELETE FROM auth_identity
            WHERE app_metadata->>'customer_id' IN (
                SELECT id FROM customer WHERE email = ${email}
            )
        `

        await sql`
            DELETE FROM customer
            WHERE email = ${email}
        `

        console.log('✅ All data deleted')
        console.log('\n📝 Now you can register this customer properly through your API:')
        console.log('\nCURL command:')
        console.log(`curl -X POST http://localhost:9000/store/auth/register \\
  -H "Content-Type: application/json" \\
  -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" \\
  -d '{
    "email": "${email}",
    "password": "Success123!",
    "first_name": "Custom",
    "last_name": "Test"
  }'`)

    } catch (error) {
        console.error('❌ Error:', error)
    } finally {
        await sql.end()
    }
}

recreateCustomer()
