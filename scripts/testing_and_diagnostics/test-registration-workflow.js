import { Client } from 'pg'
import 'dotenv/config'

const testRegistration = async () => {
    const testData = {
        first_name: 'Alejo',
        last_name: 'Vargas',
        email: 'alejosvp@gmail.com',
        password: 'alejovp32145'
    }

    console.log('🧪 Testing Registration Workflow\n')
    console.log('📝 Test Data:')
    console.log(`   Name: ${testData.first_name} ${testData.last_name}`)
    console.log(`   Email: ${testData.email}`)
    console.log(`   Password: ${testData.password}\n`)

    try {
        // Call the registration endpoint
        const response = await fetch('http://localhost:9000/store/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': process.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY || process.env.PUBLIC_PUBLISHABLE_API_KEY || ''
            },
            body: JSON.stringify(testData)
        })

        const result = await response.json()

        console.log('📡 Response Status:', response.status)
        console.log('📡 Response Body:', JSON.stringify(result, null, 2))
        console.log('')

        if (!response.ok) {
            console.log('❌ Registration failed')
            return
        }

        console.log('✅ Registration API call successful\n')

        // Now check the database
        const client = new Client({
            connectionString: process.env.DATABASE_URL
        })

        await client.connect()

        // Check customer
        const customer = await client.query(
            `SELECT id, email, has_account, created_at FROM customer WHERE email = $1`,
            [testData.email]
        )

        if (customer.rows.length > 0) {
            console.log('✅ CUSTOMER CREATED:')
            console.log(`   ID: ${customer.rows[0].id}`)
            console.log(`   has_account: ${customer.rows[0].has_account}`)
            console.log('')
        } else {
            console.log('❌ Customer not found in database\n')
            await client.end()
            return
        }

        // Check auth identity
        const identity = await client.query(
            `SELECT id, entity_id, provider, user_metadata FROM provider_identity WHERE entity_id = $1`,
            [testData.email]
        )

        console.log('🔐 AUTH IDENTITY CHECK:')
        if (identity.rows.length > 0) {
            const userMetadata = identity.rows[0].user_metadata
            const password = userMetadata?.password

            console.log(`   Provider: ${identity.rows[0].provider}`)
            console.log(`   Has password in metadata: ${!!password}`)

            if (password) {
                const isHashed = password.includes(':')
                const passwordPreview = password.length > 30
                    ? password.substring(0, 30) + '...'
                    : password

                console.log(`   Password preview: ${passwordPreview}`)
                console.log(`   Is hashed (contains ':'): ${isHashed}`)
                console.log(`   Password length: ${password.length}`)

                if (isHashed) {
                    console.log('\n✅ ✅ ✅ PASSWORD IS HASHED! ✅ ✅ ✅')
                    console.log('🎉 Workflow is working correctly!\n')
                } else {
                    console.log('\n❌ ❌ ❌ PASSWORD IS PLAIN TEXT! ❌ ❌ ❌')
                    console.log('⚠️  Workflow is NOT hashing passwords!\n')
                }
            } else {
                console.log('   ❌ No password found in metadata')
            }
        } else {
            console.log('   ❌ No auth identity found')
        }

        await client.end()

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('Test completed')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    } catch (error) {
        console.error('❌ Error:', error.message)
        if (error.cause) {
            console.error('   Cause:', error.cause)
        }
    }
}

testRegistration()
