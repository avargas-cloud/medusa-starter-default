import { Client } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

async function checkCustomer() {
    const email = 'alejosvp@gmail.com'

    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log(`🔍 Verificando usuario: ${email}\n`)

        // Check customer
        const customer = await client.query(
            `SELECT id, email, first_name, last_name, has_account, created_at 
             FROM customer WHERE email = $1`,
            [email]
        )

        if (customer.rowCount === 0) {
            console.log('❌ Customer NO encontrado')
            return
        }

        console.log('✅ Customer ENCONTRADO:')
        console.log(customer.rows[0])
        console.log('')

        // Check auth identity
        const authIdentity = await client.query(
            `SELECT ai.id, pi.entity_id, pi.provider, ai.app_metadata
             FROM auth_identity ai 
             JOIN provider_identity pi ON pi.auth_identity_id = ai.id 
             WHERE pi.entity_id = $1`,
            [email]
        )

        if (authIdentity.rowCount === 0) {
            console.log('❌ Auth identity NO encontrada')
        } else {
            console.log('✅ Auth identity ENCONTRADA:')
            console.log(authIdentity.rows[0])
        }

    } catch (error: any) {
        console.error('❌ Error:', error.message)
    } finally {
        await client.end()
    }
}

checkCustomer()
