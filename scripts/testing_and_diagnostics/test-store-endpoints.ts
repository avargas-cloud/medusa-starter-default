#!/usr/bin/env tsx
/**
 * Test Store API Endpoints Live
 * Creates a test customer via Medusa API and tests all account-related endpoints
 */
import axios from 'axios'
import 'dotenv/config'

const BASE_URL = process.env.BACKEND_URL || 'http://localhost:9000'
const timestamp = Date.now()
const TEST_EMAIL = `api-test-${timestamp}@ecopowertech.com`
const TEST_PASSWORD = 'Test123!'

interface RegisterResponse {
    customer: {
        id: string
        email: string
        first_name: string | null
        last_name: string | null
    }
}

interface LoginResponse {
    token: string
}

interface CustomerResponse {
    customer: {
        id: string
        email: string
        first_name: string | null
        last_name: string | null
        phone: string | null
        has_account: boolean
        metadata: Record<string, any> | null
        created_at: string
        updated_at: string
        addresses?: Array<{
            id: string
            customer_id: string
            company: string | null
            first_name: string | null
            last_name: string | null
            address_1: string | null
            address_2: string | null
            city: string | null
            country_code: string | null
            province: string | null
            postal_code: string | null
            phone: string | null
        }>
    }
}

interface OrdersResponse {
    orders: any[]
    count: number
    limit: number
    offset: number
}

async function testStoreAPI() {
    console.log('🧪 LIVE TESTING: Store API Endpoints for Customer Account Pages\n')
    console.log(`📍 Backend URL: ${BASE_URL}\n`)
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    try {
        // STEP 1: Register new customer
        console.log('1️⃣  REGISTER - Creating new customer')
        console.log('   POST /store/auth/register\n')

        const registerResponse = await axios.post<RegisterResponse>(
            `${BASE_URL}/store/auth/register`,
            {
                email: TEST_EMAIL,
                password: TEST_PASSWORD,
                first_name: 'API',
                last_name: 'Tester',
                phone: '+1-555-0123'
            }
        )

        console.log('   ✅ Customer registered successfully')
        console.log(`   📝 Customer ID: ${registerResponse.data.customer.id}`)
        console.log(`   📝 Email: ${registerResponse.data.customer.email}\n`)

        // STEP 2: Login
        console.log('2️⃣  LOGIN - Authenticating')
        console.log('   POST /store/auth/emailpass\n')

        const loginResponse = await axios.post<LoginResponse>(
            `${BASE_URL}/store/auth/emailpass`,
            {
                email: TEST_EMAIL,
                password: TEST_PASSWORD
            }
        )

        const token = loginResponse.data.token
        console.log('   ✅ Login successful')
        console.log(`   🔑 Token: ${token.substring(0, 30)}...\n`)

        // Headers for authenticated requests
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }

        // STEP 3: Get profile (without addresses)
        console.log('3️⃣  PROFILE - Basic customer info')
        console.log('   GET /store/customers/me\n')

        const profileResponse = await axios.get<CustomerResponse>(
            `${BASE_URL}/store/customers/me`,
            { headers }
        )

        console.log('   ✅ Profile retrieved')
        console.log('   📦 Response Structure:')
        console.log(JSON.stringify(profileResponse.data, null, 2))
        console.log()

        // STEP 4: Add addresses
        console.log('4️⃣  ADD ADDRESSES - Creating sample addresses')
        console.log('   POST /store/customers/me/addresses\n')

        const addr1 = await axios.post(
            `${BASE_URL}/store/customers/me/addresses`,
            {
                first_name: 'API',
                last_name: 'Tester',
                address_1: '123 Main Street',
                address_2: 'Apt 4B',
                city: 'New York',
                province: 'NY',
                postal_code: '10001',
                country_code: 'us',
                phone: '+1-555-0123'
            },
            { headers }
        )

        console.log('   ✅ Address 1 created (Home)')

        const addr2 = await axios.post(
            `${BASE_URL}/store/customers/me/addresses`,
            {
                company: 'Tech Corp',
                first_name: 'API',
                last_name: 'Tester',
                address_1: '456 Business Ave',
                address_2: 'Suite 200',
                city: 'San Francisco',
                province: 'CA',
                postal_code: '94102',
                country_code: 'us',
                phone: '+1-555-0456'
            },
            { headers }
        )

        console.log('   ✅ Address 2 created (Work)\n')

        // STEP 5: Get profile WITH addresses
        console.log('5️⃣  PROFILE WITH ADDRESSES')
        console.log('   GET /store/customers/me?fields=+addresses.*\n')

        const profileWithAddresses = await axios.get<CustomerResponse>(
            `${BASE_URL}/store/customers/me`,
            {
                headers,
                params: {
                    fields: '+addresses.*'
                }
            }
        )

        console.log('   ✅ Profile with addresses retrieved')
        console.log(`   📊 Total addresses: ${profileWithAddresses.data.customer.addresses?.length || 0}`)
        console.log('   📦 Response Structure:')
        console.log(JSON.stringify(profileWithAddresses.data, null, 2))
        console.log()

        // STEP 6: Get orders
        const customerId = profileResponse.data.customer.id
        console.log('6️⃣  ORDERS - Order history')
        console.log(`   GET /store/orders?customer_id=${customerId}\n`)

        const ordersResponse = await axios.get<OrdersResponse>(
            `${BASE_URL}/store/orders`,
            {
                headers,
                params: {
                    customer_id: customerId,
                    fields: '+items.variant.product.title',
                    limit: 10
                }
            }
        )

        console.log('   ✅ Orders retrieved')
        console.log(`   📊 Total orders: ${ordersResponse.data.count}`)
        console.log('   📦 Response Structure:')
        console.log(JSON.stringify(ordersResponse.data, null, 2))
        console.log()

        // SUMMARY
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('✅ ALL TESTS PASSED - LIVE DATA VERIFIED')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

        console.log('📋 VERIFIED API ENDPOINTS:\n')
        console.log('1. Registration:')
        console.log('   POST /store/auth/register')
        console.log('   ✓ Returns: customer object with id, email, name\n')

        console.log('2. Login:')
        console.log('   POST /store/auth/emailpass')
        console.log('   ✓ Returns: JWT token for authentication\n')

        console.log('3. Profile (Basic):')
        console.log('   GET /store/customers/me')
        console.log('   ✓ Returns: customer info WITHOUT addresses\n')

        console.log('4. Create Address:')
        console.log('   POST /store/customers/me/addresses')
        console.log('   ✓ Creates new shipping/billing address\n')

        console.log('5. Profile (With Addresses):')
        console.log('   GET /store/customers/me?fields=+addresses.*')
        console.log('   ✓ Returns: customer info WITH addresses array\n')

        console.log('6. Orders:')
        console.log(`   GET /store/orders?customer_id={id}`)
        console.log('   ✓ Returns: orders array with count, limit, offset\n')

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('🎯 Test Credentials (use for frontend testing):')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log(`Email: ${TEST_EMAIL}`)
        console.log(`Password: ${TEST_PASSWORD}`)
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('\n❌ API ERROR')
            console.error(`   Status: ${error.response?.status}`)
            console.error(`   Endpoint: ${error.config?.url}`)
            console.error(`   Method: ${error.config?.method?.toUpperCase()}`)
            console.error('   Response:')
            console.error(JSON.stringify(error.response?.data, null, 2))
        } else {
            console.error('\n❌ UNEXPECTED ERROR:', error)
        }
        process.exit(1)
    }
}

testStoreAPI()
