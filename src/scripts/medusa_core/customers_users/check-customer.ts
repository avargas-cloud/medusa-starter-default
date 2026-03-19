import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function checkCustomer() {
    const email = 'a.vargas@ecopowertech.com'

    const [customer] = await sql`
        SELECT id, email, has_account, metadata
        FROM customer
        WHERE email = ${email}
    `

    if (customer) {
        console.log('✅ Customer found:')
        console.log('   ID:', customer.id)
        console.log('   Email:', customer.email)
        console.log('   has_account:', customer.has_account)
        console.log('   Metadata:', JSON.stringify(customer.metadata, null, 2))
    } else {
        console.log('❌ Customer not found')
    }

    await sql.end()
}

checkCustomer()
