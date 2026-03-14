#!/usr/bin/env tsx
/**
 * Complete Password Reset Flow Test
 * Tests the entire password reset workflow end-to-end
 */

import 'dotenv/config'
import axios from 'axios'

const BACKEND_URL = 'http://localhost:9000'
const PUBLISHABLE_KEY = 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'
const TEST_EMAIL = 'a.vargas@ecopowertech.com'
const NEW_PASSWORD = 'NewPassword2024!*'  // Different from current

async function step1_RequestResetToken() {
    console.log('\n🔐 STEP 1: Requesting Password Reset Token')
    console.log('==========================================')

    const response = await axios.post(`${BACKEND_URL}/store/auth/reset-password`, {
        email: TEST_EMAIL
    }, {
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY
        }
    })

    console.log('📊 Response Status:', response.status)
    console.log('📧 Response:', JSON.stringify(response.data, null, 2))

    if (response.status !== 200) {
        throw new Error('Failed to request reset token')
    }

    console.log('✅ Reset token requested successfully')
    return true
}

async function step2_GetTokenFromDB() {
    console.log('\n🔍 STEP 2: Retrieving Reset Token from Database')
    console.log('================================================')

    const { getSql } = await import('../../../lib/db.js')
    const sql = getSql()

    const customers = await sql`
        SELECT id, email, metadata 
        FROM customer 
        WHERE email = ${TEST_EMAIL}
    `

    if (customers.length === 0) {
        throw new Error('Customer not found')
    }

    const customer = customers[0]
    const metadata = customer.metadata as any
    const resetToken = metadata?.reset_token
    const resetExpires = metadata?.reset_expires

    console.log('📊 Customer ID:', customer.id)
    console.log('📧 Email:', customer.email)
    console.log('🔑 Reset Token:', resetToken)
    console.log('⏰ Expires:', new Date(resetExpires).toLocaleString())

    if (!resetToken) {
        throw new Error('Reset token not found in customer metadata')
    }

    console.log('✅ Token retrieved from database')
    return resetToken
}

async function step3_ConfirmPasswordReset(token: string) {
    console.log('\n🔐 STEP 3: Confirming Password Reset')
    console.log('====================================')
    console.log('🔑 Using Token:', token.substring(0, 20) + '...')
    console.log('🔐 New Password:', NEW_PASSWORD)

    const response = await axios.post(`${BACKEND_URL}/store/auth/reset-password/confirm`, {
        token: token,
        password: NEW_PASSWORD
    }, {
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY
        }
    })

    console.log('📊 Response Status:', response.status)
    console.log('📧 Response:', JSON.stringify(response.data, null, 2))

    if (response.status !== 200) {
        throw new Error(`Password reset confirmation failed: ${response.data.error || 'Unknown error'}`)
    }

    console.log('✅ Password reset confirmed successfully')
    return true
}

async function step4_VerifyLogin() {
    console.log('\n🔐 STEP 4: Verifying Login with New Password')
    console.log('=============================================')

    const response = await axios.post(`${BACKEND_URL}/store/auth/login`, {
        email: TEST_EMAIL,
        password: NEW_PASSWORD
    }, {
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY
        }
    })

    console.log('📊 Response Status:', response.status)
    console.log('📧 Response:', JSON.stringify(response.data, null, 2))

    if (response.status !== 200) {
        throw new Error('Login failed with new password')
    }

    console.log('✅ Login successful with new password!')
    return true
}

async function main() {
    console.log('🧪 PASSWORD RESET FLOW TEST')
    console.log('============================')
    console.log('📧 Email:', TEST_EMAIL)
    console.log('🔐 New Password:', NEW_PASSWORD)
    console.log('🌐 Backend:', BACKEND_URL)

    try {
        // Step 1: Request reset token
        await step1_RequestResetToken()

        // Wait a bit for email to process (optional)
        console.log('\n⏳ Waiting 2 seconds for email processing...')
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Step 2: Get token from DB
        const token = await step2_GetTokenFromDB()

        // Step 3: Confirm password reset
        await step3_ConfirmPasswordReset(token)

        // Step 4: Verify login
        await step4_VerifyLogin()

        console.log('\n\n🎉 🎉 🎉 ALL TESTS PASSED! 🎉 🎉 🎉')
        console.log('Password reset flow is working correctly!')

    } catch (error: any) {
        console.error('\n\n❌ ❌ ❌ TEST FAILED ❌ ❌ ❌')
        console.error('Error:', error.message)
        console.error('Stack:', error.stack)
        process.exit(1)
    }
}

main()
