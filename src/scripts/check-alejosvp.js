import { Client } from 'pg'
import 'dotenv/config'

const checkUser = async () => {
    const email = 'alejosvp@gmail.com'

    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log(`🔍 Verificando: ${email}\n`)

        // Check customer
        const customer = await client.query(
            `SELECT id, email, has_account, created_at FROM customer WHERE email = $1`,
            [email]
        )

        if (customer.rows.length > 0) {
            console.log('✅ CUSTOMER EXISTE:')
            console.log('   ID:', customer.rows[0].id)
            console.log('   has_account:', customer.rows[0].has_account)
            console.log('\n')
        } else {
            console.log('❌ Customer no existe\n')
            return
        }

        // Check provider identity with password
        const identity = await client.query(
            `SELECT id, entity_id, provider, user_metadata FROM provider_identity WHERE entity_id = $1`,
            [email]
        )

        console.log('🔐 AUTH IDENTITY:')
        if (identity.rows.length > 0) {
            const userMetadata = identity.rows[0].user_metadata
            console.log('   Provider:', identity.rows[0].provider)
            console.log('   Has password in metadata:', !!userMetadata?.password)

            if (userMetadata?.password) {
                const pwd = userMetadata.password
                console.log('   Password format:', pwd.substring(0, 20) + '...')
                console.log('   Is hashed (has :):', pwd.includes(':'))
                console.log('   Length:', pwd.length)
            }
        } else {
            console.log('   ❌ No auth identity found')
        }

    } catch (error) {
        console.error('❌ Error:', error.message)
    } finally {
        await client.end()
    }
}

checkUser()
