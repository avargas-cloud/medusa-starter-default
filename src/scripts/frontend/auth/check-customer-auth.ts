import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function checkCustomer() {
    const [customer] = await sql`
        SELECT c.id, c.email, c.has_account,
               ai.id as auth_id,
               pi.provider, pi.entity_id
        FROM customer c
        LEFT JOIN auth_identity ai ON ai.app_metadata->>'customer_id' = c.id
        LEFT JOIN provider_identity pi ON pi.auth_identity_id = ai.id
        WHERE c.email = 'customtest_1740685200@test.com'
    `

    console.log('Customer data:', JSON.stringify(customer, null, 2))

    if (customer?.auth_id) {
        const [pi] = await sql`
            SELECT provider_metadata 
            FROM provider_identity 
            WHERE auth_identity_id = ${customer.auth_id}
        `
        console.log('Has password hash:', !!pi?.provider_metadata)
    }

    await sql.end()
}

checkCustomer()
