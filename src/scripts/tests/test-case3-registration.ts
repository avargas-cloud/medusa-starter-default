#!/usr/bin/env tsx
/**
 * Test Case 3 Registration Flow
 * Simulates frontend registration form submission
 */

async function testCase3Registration() {
    const testData = {
        email: 'a.vargas@ecopowertech.com',
        password: 'TestPassword123!',
        first_name: 'Alejandro',
        last_name: 'Vargas'
    }

    console.log('🧪 Testing Case 3 Registration Flow')
    console.log('━'.repeat(50))
    console.log('📧 Email:', testData.email)
    console.log('🔐 Password:', '******** (hidden)')
    console.log('')

    try {
        const response = await fetch('http://localhost:9000/store/auth/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'
            },
            body: JSON.stringify(testData)
        })

        const statusCode = response.status
        const responseData = await response.json()

        console.log('📊 Response Status:', statusCode)
        console.log('📦 Response Data:')
        console.log(JSON.stringify(responseData, null, 2))
        console.log('')

        if (statusCode === 200) {
            if (responseData.needs_activation) {
                console.log('✅ SUCCESS: Case 3 detected!')
                console.log('📧 Activation email should have been sent')
                console.log('')
                console.log('💡 Next steps:')
                console.log('   1. Check database for activation_token in metadata')
                console.log('   2. Run: npx -y tsx src/scripts/debug-case3-customer.ts a.vargas@ecopowertech.com')
            } else {
                console.log('⚠️  Unexpected: Registration succeeded but no activation needed')
            }
        } else {
            console.log('❌ FAILED: Registration returned error')
        }

    } catch (error) {
        console.error('❌ Request failed:', error)
        if (error instanceof Error) {
            console.error('   Message:', error.message)
        }
    }
}

testCase3Registration()
