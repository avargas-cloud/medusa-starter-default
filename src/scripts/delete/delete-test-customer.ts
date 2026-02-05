/**
 * Script to completely delete a test customer (Auth Identity + Customer Profile)
 * Usage: email=test@example.com npx medusa exec ./src/scripts/delete-test-customer.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types"

export default async function deleteTestCustomer(container: MedusaContainer) {
    const email = process.env.email

    if (!email) {
        console.error('❌ Error: Email required')
        console.log('Usage: email=test@example.com npx medusa exec ./src/scripts/delete-test-customer.ts')
        return
    }

    console.log(`🔍 Looking for customer: ${email}\n`)

    // Get query for direct database access
    const query = container.resolve('query')

    let authDeleted = false
    let customerDeleted = false
    let authId = null
    let customerId = null

    try {
        // 1. Find customer
        const result = await query.graph({
            entity: 'customer',
            filters: { email },
            fields: ['id', 'email']
        })

        const customers = result.data || []

        if (!customers || customers.length === 0) {
            console.log('⚠️  Customer not found (may not have existed)')
        } else {
            customerId = customers[0].id
            console.log(`📌 Customer ID: ${customerId}`)
        }

        // 2. Delete provider identities first (auth identity)
        const knex = container.resolve('__pg_connection__') as any

        if (knex) {
            const deletedIdentities = await knex('provider_identity')
                .where('entity_id', email)
                .del()
                .returning('id')

            if (deletedIdentities.length > 0) {
                authDeleted = true
                authId = deletedIdentities[0].id
                console.log(`✅ Provider identities deleted: ${deletedIdentities.length}`)
            }
        }

        // 3. Delete customer using the customer module service
        if (customerId) {
            await knex('customer')
                .where('id', customerId)
                .del()

            customerDeleted = true
            console.log(`✅ Customer deleted: ${customerId}`)
        }

    } catch (error: any) {
        console.error('❌ Error during deletion:', error.message)
        throw error
    }

    // 4. Report results
    console.log('\n📋 Deletion Results:')
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

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✨ Email can now be reused for registration')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}
