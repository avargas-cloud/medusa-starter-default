import { Client } from 'pg'
import 'dotenv/config'

const deleteUser = async () => {
    const email = 'alejosvp@gmail.com'

    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log(`🗑️  Eliminando usuario: ${email}\n`)

        // Get customer ID
        const customerResult = await client.query(
            `SELECT id FROM customer WHERE email = $1`,
            [email]
        )

        if (customerResult.rows.length === 0) {
            console.log('❌ Usuario no encontrado')
            return
        }

        const customerId = customerResult.rows[0].id
        console.log(`📌 Customer ID: ${customerId}`)

        // Delete provider identities
        const deleteIdentities = await client.query(
            `DELETE FROM provider_identity 
             WHERE entity_id = $1 
             RETURNING id`,
            [email]
        )
        console.log(`✅ Provider identities eliminadas: ${deleteIdentities.rowCount}`)

        // Delete customer
        const deleteCustomer = await client.query(
            `DELETE FROM customer WHERE id = $1 RETURNING id`,
            [customerId]
        )
        console.log(`✅ Customer eliminado: ${deleteCustomer.rowCount}`)

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('✅ alejosvp@gmail.com eliminado')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    } catch (error) {
        console.error('❌ Error:', error.message)
    } finally {
        await client.end()
    }
}

deleteUser()
