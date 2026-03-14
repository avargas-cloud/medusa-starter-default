import 'dotenv/config'
import axios from 'axios'

const BACKEND_URL = 'http://localhost:9000'
const PUBLISHABLE_KEY = process.env.PUBLISHABLE_API_KEY!

async function testPasswordResetWithToken() {
    console.log('\n🔐 Testing Password Reset Confirm with Auto-Login\n')

    const token = '0ceef558d527e29b571a6fb5c8cee9e7c045ae20435d5bc26215958001b7b846'
    const newPassword = 'NewTestPassword123!'

    try {
        console.log('📧 Confirming password reset...')
        console.log('Token:', token.substring(0, 20) + '...')
        console.log('New password: [hidden]')

        const response = await axios.post(
            `${BACKEND_URL}/store/auth/reset-password/confirm`,
            {
                token: token,
                password: newPassword
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-publishable-api-key': PUBLISHABLE_KEY
                }
            }
        )

        console.log('\n✅ Response received')
        console.log('Status:', response.status)
        console.log('\n📦 Response body:')
        console.log(JSON.stringify(response.data, null, 2))

        if (response.data.token) {
            console.log('\n✅ ✅ ✅ TOKEN RECEIVED!')
            console.log('Token preview:', response.data.token.substring(0, 50) + '...')
        } else {
            console.log('\n❌ ❌ ❌ NO TOKEN IN RESPONSE')
        }

    } catch (error: any) {
        console.error('\n❌ Error:', error.response?.data || error.message)
    }
}

testPasswordResetWithToken()
