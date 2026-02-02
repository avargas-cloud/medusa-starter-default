import 'dotenv/config'

const testRegistration = async () => {
    console.log('🧪 Testing NEW registration with native endpoints\n')

    try {
        const response = await fetch('http://localhost:9000/store/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': process.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY || ''
            },
            body: JSON.stringify({
                email: 'alejosvp@gmail.com',
                password: 'alejovp32145',
                first_name: 'Alejo',
                last_name: 'Vargas'
            })
        })

        const result = await response.json()

        console.log('📊 Response Status:', response.status)
        console.log('📦 Response:', JSON.stringify(result, null, 2))
        console.log('')

        if (response.ok && result.success) {
            console.log('✅ Registration successful!')

            // Now check database
            const { Client } = await import('pg')
            const client = new Client({ connectionString: process.env.DATABASE_URL })
            await client.connect()

            const dbResult = await client.query(`
                SELECT 
                    pi.provider_metadata,
                    pi.user_metadata,
                    c.has_account
                FROM provider_identity pi
                JOIN auth_identity ai ON pi.auth_identity_id = ai.id
                JOIN customer c ON c.email = pi.entity_id
                WHERE pi.entity_id = 'alejosvp@gmail.com' 
                  AND pi.provider = 'emailpass'
            `)

            if (dbResult.rows.length > 0) {
                const row = dbResult.rows[0]
                console.log('🔍 Database Check:')
                console.log('   has_account:', row.has_account)
                console.log('   provider_metadata:', JSON.stringify(row.provider_metadata, null, 2))
                console.log('   user_metadata:', JSON.stringify(row.user_metadata, null, 2))
                console.log('')

                if (row.provider_metadata?.password) {
                    console.log('✅ SUCCESS! Password is in provider_metadata (hashed)')
                } else {
                    console.log('❌ FAIL! Password not in provider_metadata')
                }
            }

            await client.end()
        } else {
            console.log('❌ Registration failed')
        }

    } catch (error) {
        console.error('❌ Error:', error.message)
    }
}

testRegistration()
