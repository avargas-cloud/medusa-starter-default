#!/usr/bin/env tsx
/**
 * Create a test customer with known credentials for API testing
 */
import { Client } from 'pg'
import dotenv from 'dotenv'
import { scryptSync, randomBytes } from 'crypto'

dotenv.config()

const timestamp = Date.now()
const TEST_EMAIL = `api-test-${timestamp}@ecopowertech.com`
const TEST_PASSWORD = 'Test123!'
const TEST_CUSTOMER_ID = `cus_api_test_${timestamp}`

async function createTestCustomer() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log('✅ Connected to database\n')

        // Hash password using scrypt (Medusa's method)
        const salt = randomBytes(16).toString('hex')
        const derivedKey = scryptSync(TEST_PASSWORD, salt, 64)
        const hashedPassword = `${derivedKey.toString('hex')}.${salt}`

        // Create customer
        console.log('1️⃣  Creating customer...')
        await client.query(`
            INSERT INTO customer (id, email, first_name, last_name, phone, has_account, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        `, [TEST_CUSTOMER_ID, TEST_EMAIL, 'API', 'Tester', '+1-555-0123', true])

        console.log(`   ✅ Customer created: ${TEST_CUSTOMER_ID}`)

        // Create auth identity
        console.log('2️⃣  Creating auth identity...')
        const authId = `auth_${TEST_CUSTOMER_ID}`

        await client.query(`
            INSERT INTO auth_identity (id, provider_identities, app_metadata, created_at, updated_at)
            VALUES ($1, $2, $3, NOW(), NOW())
        `, [
            authId,
            JSON.stringify({
                emailpass: {
                    password: hashedPassword
                }
            }),
            JSON.stringify({
                customer_id: TEST_CUSTOMER_ID
            })
        ])

        console.log(`   ✅ Auth identity created: ${authId}`)

        // Create sample addresses
        console.log('3️⃣  Creating sample addresses...')

        const addresses = [
            {
                id: `addr_home_${timestamp}`,
                first_name: 'API',
                last_name: 'Tester',
                address_1: '123 Main Street',
                address_2: 'Apt 4B',
                city: 'New York',
                province: 'NY',
                postal_code: '10001',
                country_code: 'US',
                phone: '+1-555-0123'
            },
            {
                id: `addr_work_${timestamp + 1}`,
                first_name: 'API',
                last_name: 'Tester',
                company: 'Tech Corp',
                address_1: '456 Business Ave',
                address_2: 'Suite 200',
                city: 'San Francisco',
                province: 'CA',
                postal_code: '94102',
                country_code: 'US',
                phone: '+1-555-0456'
            }
        ]

        for (const addr of addresses) {
            await client.query(`
                INSERT INTO customer_address (
                    id, customer_id, company, first_name, last_name,
                    address_1, address_2, city, province, postal_code,
                    country_code, phone, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
            `, [
                addr.id, TEST_CUSTOMER_ID, addr.company || null,
                addr.first_name, addr.last_name, addr.address_1,
                addr.address_2 || null, addr.city, addr.province,
                addr.postal_code, addr.country_code, addr.phone || null
            ])
        }

        console.log(`   ✅ Created ${addresses.length} addresses\n`)

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('🎉 Test customer ready!')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log(`Email: ${TEST_EMAIL}`)
        console.log(`Password: ${TEST_PASSWORD}`)
        console.log(`Customer ID: ${TEST_CUSTOMER_ID}`)
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    } catch (error) {
        console.error('❌ Error:', error)
        throw error
    } finally {
        await client.end()
    }
}

createTestCustomer()
