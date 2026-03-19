import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function cleanMetadata() {
    const email = 'a.vargas@ecopowertech.com'

    // Clean metadata to ONLY legacy_customer flag
    await sql`
        UPDATE customer
        SET metadata = ${JSON.stringify({
        legacy_customer: true
    })}::jsonb
        WHERE email = ${email}
    `

    console.log('✅ Metadata cleaned for', email)

    const [customer] = await sql`
        SELECT id, email, has_account, metadata
        FROM customer
        WHERE email = ${email}
    `

    console.log('\n📋 Customer state:')
    console.log('   has_account:', customer.has_account)
    console.log('   metadata:', customer.metadata)

    await sql.end()
}

cleanMetadata()
