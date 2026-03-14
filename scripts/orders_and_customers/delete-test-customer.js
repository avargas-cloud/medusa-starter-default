#!/usr/bin/env node

/**
 * Script to completely delete a test customer (Auth Identity + Customer Profile)
 * Usage: node src/scripts/delete-test-customer.js test@example.com
 */

async function deleteCustomer(email) {
    if (!email) {
        console.error('❌ Error: Email required')
        console.log('Usage: node src/scripts/delete-test-customer.js test@example.com')
        process.exit(1)
    }

    console.log(`🔍 Looking for customer: ${email}\n`)

    try {
        // Initialize Medusa
        const { MedusaApp, Modules } = require('@medusajs/framework')
        const { container } = await MedusaApp({ loadEnv: true })

        const authModule = container.resolve(Modules.AUTH)
        const customerModule = container.resolve(Modules.CUSTOMER)

        let authDeleted = false
        let customerDeleted = false
        let authId = null
        let customerId = null

        // 1. Find and delete Auth Identity
        try {
            const identities = await authModule.listAuthIdentities()
            const matchingIdentity = identities.find(identity =>
                identity.provider_identities?.some(pi => pi.entity_id === email)
            )

            if (matchingIdentity) {
                await authModule.deleteAuthIdentities([matchingIdentity.id])
                authDeleted = true
                authId = matchingIdentity.id
            }
        } catch (error) {
            console.error('⚠️  Error deleting auth identity:', error.message)
        }

        // 2. Find and delete Customer Profile
        try {
            const customers = await customerModule.listCustomers({ email })

            if (customers.length > 0) {
                const customer = customers[0]
                await customerModule.deleteCustomers([customer.id])
                customerDeleted = true
                customerId = customer.id
            }
        } catch (error) {
            console.error('⚠️  Error deleting customer:', error.message)
        }

        // 3. Report results
        console.log('📋 Deletion Results:')
        console.log('─────────────────────')

        if (authDeleted) {
            console.log(`✅ Auth Identity deleted: ${authId}`)
        } else {
            console.log('⚠️  Auth Identity not found (may not have existed)')
        }

        if (customerDeleted) {
            console.log(`✅ Customer Profile deleted: ${customerId}`)
        } else {
            console.log('⚠️  Customer Profile not found (may not have existed)')
        }

        console.log('\n✨ Email can now be reused for registration\n')
        process.exit(0)

    } catch (error) {
        console.error('❌ Error:', error.message)
        console.error(error.stack)
        process.exit(1)
    }
}

// Get email from command line
const email = process.argv[2]
deleteCustomer(email)
