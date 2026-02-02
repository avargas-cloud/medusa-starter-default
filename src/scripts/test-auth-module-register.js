import { Client } from 'pg'
import 'dotenv/config'

const testAuthModuleRegister = async () => {
    console.log('🧪 Testing AuthModule.register() method\n')

    try {
        // Test calling the auth module directly
        const response = await fetch('http://localhost:9000/store/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': process.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY || ''
            },
            body: JSON.stringify({
                email: 'test_auth_module@test.com',
                password: 'test123456',
                first_name: 'Test',
                last_name: 'User'
            })
        })

        const result = await response.json()
        console.log('Registration response:', JSON.stringify(result, null, 2))
        console.log('')

        // Check database
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        await client.connect()

        const dbResult = await client.query(`
            SELECT 
                pi.provider_metadata,
                pi.user_metadata
            FROM provider_identity pi
            WHERE pi.entity_id = 'test_auth_module@test.com'
        `)

        if (dbResult.rows.length > 0) {
            console.log('📦 Database check:')
            console.log('   provider_metadata:', dbResult.rows[0].provider_metadata)
            console.log('   user_metadata:', dbResult.rows[0].user_metadata)

            // Cleanup
            await client.query(`DELETE FROM customer WHERE email = 'test_auth_module@test.com'`)
        }

        await client.end()

    } catch (error) {
        console.error('❌ Error:', error.message)
    }
}

testAuthModuleRegister()
