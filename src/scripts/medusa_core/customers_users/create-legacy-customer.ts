import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"
import { generateEntityId } from "@medusajs/utils"

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function createLegacyCustomer() {
    const emailArgIndex = process.argv.indexOf('--email')
    const emailPassed = emailArgIndex > -1 ? process.argv[emailArgIndex + 1] : null
    const email = emailPassed || 'legacy_test@test.com'

    console.log('🗑️  Deleting any existing customer with this email...')

    // Delete any existing customer
    await sql`
        DELETE FROM customer
        WHERE email = ${email}
    `

    console.log('✅ Creating legacy customer (has_account=false, legacy_customer=true)...')

    const customerId = generateEntityId('', 'cus')

    // Create legacy customer (imported from QuickBooks)
    const [customer] = await sql`
        INSERT INTO customer (
            id,
            email,
            first_name,
            last_name,
            has_account,
            metadata,
            created_at,
            updated_at
        ) VALUES (
            ${customerId},
            ${email},
            'Legacy',
            'Customer',
            false,
            ${{ legacy_customer: true, qb_customer_id: 'TEST123' }}::jsonb,
            NOW(),
            NOW()
        )
        RETURNING *
    `

    console.log('✅ Legacy customer created:', customer.id)
    console.log('📧 Email:', customer.email)
    console.log('🏷️  Metadata:', customer.metadata)
    console.log('\n📝 Now test Case 3 with:')
    console.log(`curl -X POST http://localhost:9000/store/auth/register \\
  -H "Content-Type: application/json" \\
  -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" \\
  -d '{
    "email": "${email}",
    "password": "NewPassword123!",
    "first_name": "Legacy",
    "last_name": "Customer"
  }'`)

    await sql.end()
}

createLegacyCustomer()
