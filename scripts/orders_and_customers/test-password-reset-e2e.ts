import postgres from 'postgres'

const BASE_URL = 'http://localhost:9000'
const TEST_EMAIL = 'a.vargas@ecopowertech.com' // Usuario existente
const NEW_PASSWORD = 'NewTestPass123!'
const API_KEY = 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'

const sql = postgres(process.env.DATABASE_URL!)

async function testPasswordReset() {
    console.log('🧪 ==========================================')
    console.log('🧪 TESTING PASSWORD RESET END-TO-END')
    console.log('🧪 ==========================================\n')

    try {
        // STEP 1: Request password reset
        console.log('📧 STEP 1: Requesting password reset...')
        const resetResponse = await fetch(`${BASE_URL}/store/auth/reset-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': API_KEY
            },
            body: JSON.stringify({ email: TEST_EMAIL })
        })

        const resetResult = await resetResponse.json()
        console.log('✅ Reset response:', resetResult)

        if (!resetResponse.ok) {
            throw new Error('Reset request failed')
        }

        // STEP 2: Get reset token from database
        console.log('\n🔍 STEP 2: Extracting reset token from database...')
        const customerResult = await sql`
            SELECT id, email, metadata
            FROM customer
            WHERE email = ${TEST_EMAIL}
            LIMIT 1
        `

        if (!customerResult[0]) {
            throw new Error('Customer not found')
        }

        const customer = customerResult[0]
        const resetToken = customer.metadata?.reset_token
        const resetExpires = customer.metadata?.reset_expires

        console.log('✅ Customer ID:', customer.id)
        console.log('✅ Reset token:', resetToken?.substring(0, 20) + '...')
        console.log('✅ Reset expires:', resetExpires)

        if (!resetToken) {
            throw new Error('Reset token not found in metadata')
        }

        // STEP 3: Confirm password reset
        console.log('\n🔐 STEP 3: Confirming password reset with new password...')
        const confirmResponse = await fetch(`${BASE_URL}/store/auth/reset-password/confirm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': API_KEY
            },
            body: JSON.stringify({
                token: resetToken,
                password: NEW_PASSWORD
            })
        })

        const confirmResult = await confirmResponse.json()
        console.log('✅ Confirm response:', JSON.stringify(confirmResult, null, 2))

        if (!confirmResponse.ok) {
            throw new Error(`Confirm failed: ${JSON.stringify(confirmResult)}`)
        }

        // STEP 4: Verify password hash in database
        console.log('\n🔍 STEP 4: Verifying password hash in database...')
        const authResult = await sql`
            SELECT 
                ai.id as auth_id,
                ai.app_metadata,
                pi.id as provider_id,
                pi.provider,
                pi.provider_metadata
            FROM auth_identity ai
            JOIN provider_identity pi ON pi.auth_identity_id = ai.id
            WHERE ai.app_metadata->>'customer_id' = ${customer.id}
            AND pi.provider = 'emailpass'
            LIMIT 1
        `

        if (!authResult[0]) {
            throw new Error('Auth identity not found')
        }

        const auth = authResult[0]
        const passwordHash = auth.provider_metadata?.password

        console.log('✅ Auth Identity ID:', auth.auth_id)
        console.log('✅ Provider Identity ID:', auth.provider_id)
        console.log('✅ Password hash exists:', !!passwordHash)
        console.log('✅ Password hash length:', passwordHash?.length)
        console.log('✅ Password hash preview:', passwordHash?.substring(0, 50) + '...')

        if (!passwordHash) {
            throw new Error('Password hash not found in provider_metadata')
        }

        // STEP 5: Attempt login with new password
        console.log('\n🔑 STEP 5: Attempting login with NEW password...')
        const loginResponse = await fetch(`${BASE_URL}/store/auth/emailpass`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': API_KEY
            },
            body: JSON.stringify({
                email: TEST_EMAIL,
                password: NEW_PASSWORD
            })
        })

        const loginResult = await loginResponse.json()
        console.log('✅ Login response status:', loginResponse.status)
        console.log('✅ Login response:', JSON.stringify(loginResult, null, 2))

        if (!loginResponse.ok) {
            throw new Error(`Login failed: ${JSON.stringify(loginResult)}`)
        }

        // STEP 6: Verify token
        if (loginResult.token) {
            console.log('\n✅ Token received:', loginResult.token.substring(0, 50) + '...')
        }

        console.log('\n🎉 ==========================================')
        console.log('🎉 ALL TESTS PASSED!')
        console.log('🎉 Password reset flow works correctly')
        console.log('🎉 ==========================================\n')

        return true

    } catch (error: any) {
        console.error('\n❌ ==========================================')
        console.error('❌ TEST FAILED!')
        console.error('❌ Error:', error.message)
        console.error('❌ ==========================================\n')
        throw error
    } finally {
        await sql.end()
    }
}

testPasswordReset()
