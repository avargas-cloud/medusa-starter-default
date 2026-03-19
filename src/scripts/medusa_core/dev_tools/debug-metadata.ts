import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function checkMetadata() {
    const email = 'a.vargas@ecopowertech.com'

    const [customer] = await sql`
        SELECT id, email, has_account, metadata
        FROM customer
        WHERE email = ${email}
    `

    console.log('Customer metadata type:', typeof customer.metadata)
    console.log('Customer metadata:', customer.metadata)
    console.log('Is array?:', Array.isArray(customer.metadata))

    if (Array.isArray(customer.metadata)) {
        console.log('\n📋 Metadata items:')
        customer.metadata.forEach((item, idx) => {
            console.log(`  [${idx}]:`, typeof item, item)
        })

        // Find legacy_customer flag
        const legacyFlag = customer.metadata.find(item =>
            item?.legacy_customer === true || item?.legacy_customer === 'true'
        )
        console.log('\n✅ Legacy customer flag found:', !!legacyFlag)
    }

    await sql.end()
}

checkMetadata()
