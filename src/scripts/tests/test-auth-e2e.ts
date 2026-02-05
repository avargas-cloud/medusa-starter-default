#!/usr/bin/env tsx
/**
 * Complete E2E Authentication Test
 * Tests: Password Reset → Confirm → Login (100% Gold Standard)
 */

import 'dotenv/config'
import axios from 'axios'
import { getSql } from '../lib/db.js'

const BACKEND_URL = 'http://localhost:9000'
const TEST_EMAIL = 'a.vargas@ecopowertech.com'
const NEW_PASSWORD = 'TestPassword123!'

async function step1_RequestResetToken() {
    console.log('\n🔐 STEP 1: Requesting Password Reset Token')
    console.log('==========================================')

    const response = await axios.post(`${BACKEND_URL}/store/auth/reset-password`, {
        email: TEST_EMAIL
    }, {
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': process.env.PUBLISHABLE_API_KEY!
        }
    })

    console.log('📊 Response Status:', response.status)
    console.log('📧 Response:', JSON.stringify(response.data, null, 2))
    console.log('✅ Reset token requested successfully')
}

async function step2_GetTokenFromDB(): Promise<string> {
    console.log('\n🔍 STEP 2: Retrieving Reset Token from Database')
    console.log('================================================')

    const sql = getSql()

    const customers = await sql`
        SELECT id, email, metadata
        FROM customer
        WHERE email = ${TEST_EMAIL}
        AND deleted_at IS NULL
    `

    if (customers.length === 0) {
        throw new Error('Customer not found')
    }

    const customer = customers[0]
    const metadata = customer.metadata as any

    console.log('📊 Customer ID:', customer.id)
    console.log('📧 Email:', customer.email)
    console.log('🔑 Reset Token:', metadata.reset_token)
    console.log('⏰ Expires:', new Date(metadata.reset_expires).toLocaleString())
    console.log('✅ Token retrieved from database')

    return metadata.reset_token
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
            'x-publishable-api-key': process.env.PUBLISHABLE_API_KEY!
        }
    })

    console.log('📊 Response Status:', response.status)
    console.log('📧 Response:', JSON.stringify(response.data, null, 2))
    console.log('✅ Password reset confirmed successfully')
}

async function step4_LoginWithNewPassword() {
    console.log('\n🔐 STEP 4: Login with New Password (Custom Endpoint)')
    console.log('=============================================')

    try {
        const response = await axios.post(`${BACKEND_URL}/store/auth/login`, {
            email: TEST_EMAIL,
            password: NEW_PASSWORD
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': process.env.PUBLISHABLE_API_KEY!
            }
        })

        console.log('📊 Response Status:', response.status)
        console.log('✅ Login Response:', JSON.stringify(response.data, null, 2))
        console.log('🎉 LOGIN SUCCESSFUL!')

        return response.data.token
    } catch (error: any) {
        console.error('❌ Login failed')
        console.error('Status:', error.response?.status)
        console.error('Error:', JSON.stringify(error.response?.data, null, 2))
        throw error
    }
}

async function step5_LoginGoldStandard() {
    console.log('\n🔐 STEP 5: Login with Medusa Gold Standard Endpoint')
    console.log('=============================================')

    try {
        const response = await axios.post(`${BACKEND_URL}/auth/customer/emailpass`, {
            email: TEST_EMAIL,
            password: NEW_PASSWORD
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        })

        console.log('📊 Response Status:', response.status)
        console.log('✅ Login Response:', JSON.stringify(response.data, null, 2))
        console.log('🎉 GOLD STANDARD LOGIN SUCCESSFUL!')

        return response.data.token
    } catch (error: any) {
        console.error('❌ Gold standard login failed')
        console.error('Status:', error.response?.status)
        console.error('Error:', JSON.stringify(error.response?.data, null, 2))
        throw error
    }
}

async function main() {
    try {
        console.log('🧪 E2E AUTHENTICATION TEST (Gold Standard)')
        console.log('===========================================')
        console.log('📧 Email:', TEST_EMAIL)
        console.log('🔐 New Password:', NEW_PASSWORD)
        console.log('🌐 Backend:', BACKEND_URL)

        // Step 1: Request reset token
        await step1_RequestResetToken()

        // Wait for email to process
        console.log('\n⏳ Waiting 2 seconds for email processing...')
        await new Promise(resolve => setTimeout(resolve, 2000))

        // Step 2: Get token from DB
        const token = await step2_GetTokenFromDB()

        // Step 3: Confirm password reset
        await step3_ConfirmPasswordReset(token)

        // Step 4: Login with custom endpoint
        await step4_LoginWithNewPassword()

        // Step 5: Login with gold standard endpoint
        await step5_LoginGoldStandard()

        console.log('\n\n✅ ✅ ✅ ALL TESTS PASSED ✅ ✅ ✅')
        console.log('🎉 Password reset AND login working perfectly!')

    } catch (error: any) {
        console.log('\n\n❌ ❌ ❌ TEST FAILED ❌ ❌ ❌')
        console.log('Error:', error.message)
        if (error.stack) {
            console.log('Stack:', error.stack)
        }
        process.exit(1)
    }
}

main()
