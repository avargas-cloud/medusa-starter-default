/**
 * Script to completely delete a test customer (Auth Identity + Customer Profile)
 * Usage: npx medusa exec ./src/scripts/delete-test-customer.ts --email=test@example.com
 */

import { Modules } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"

export default async function deleteTestCustomer(container: MedusaContainer) {
    const email = process.env.email

    if (!email) {
        console.error('❌ Error: Email required')
        console.log('Usage: npx medusa exec ./src/scripts/delete-test-customer.ts --email=test@example.com')
        return
    }

    console.log(`🔍 Looking for customer: ${email}\n`)

    const authModule = container.resolve(Modules.AUTH)
    const customerModule = container.resolve(Modules.CUSTOMER)

    let authDeleted = false
    let customerDeleted = false
    let authId = null
    let customerId = null

    // 1. Find and delete Auth Identity
    try {
        const identities = await authModule.listAuthIdentities()
        const matchingIdentity = identities.find((identity: any) =>
            identity.provider_identities?.some((pi: any) => pi.entity_id === email)
        )

        if (matchingIdentity) {
            await authModule.deleteAuthIdentities([matchingIdentity.id])
            authDeleted = true
            authId = matchingIdentity.id
        }
    } catch (error: any) {
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
    } catch (error: any) {
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
}
