import 'dotenv/config'
import { getSql } from '../lib/db.js'

async function forceResetToLegacy() {
    const sql = getSql()
    const email = 'a.vargas@ecopowertech.com'

    console.log(`\n🔧 FORCE RESET: ${email} → legacy state\n`)

    try {
        // 1. Get customer
        const [customer] = await sql`
            SELECT id, email, metadata FROM customer WHERE email = ${email}
        `

        if (!customer) {
            console.log('❌ Customer not found')
            process.exit(1)
        }

        console.log('✅ Customer found:', customer.id)

        // 2. DELETE all auth records
        console.log('\n🗑️  Step 1: Deleting ALL auth data...')

        const deletedProviders = await sql`
            DELETE FROM provider_identity
            WHERE entity_id = ${email}
            RETURNING id
        `
        console.log(`   Deleted ${deletedProviders.length} provider_identity records`)

        const deletedAuth = await sql`
            DELETE FROM auth_identity
            WHERE app_metadata->>'customer_id' = ${customer.id}
            RETURNING id
        `
        console.log(`   Deleted ${deletedAuth.length} auth_identity records`)

        // 3. CLEAR metadata and set legacy state
        console.log('\n🔄 Step 2: Resetting customer state...')

        const newMetadata = {
            legacy_customer: true,
            reset_at: new Date().toISOString()
        }

        await sql`
            UPDATE customer
            SET 
                has_account = false,
                metadata = ${sql.json(newMetadata)}
            WHERE id = ${customer.id}
        `

        console.log('   ✅ Customer reset to legacy state')

        // 4. VERIFY final state
        console.log('\n✅ Step 3: Verifying final state...')

        const [verifyCustomer] = await sql`
            SELECT id, email, has_account, metadata FROM customer WHERE id = ${customer.id}
        `

        const verifyAuth = await sql`
            SELECT COUNT(*)::int as count FROM auth_identity 
            WHERE app_metadata->>'customer_id' = ${customer.id}
        `

        const verifyProvider = await sql`
            SELECT COUNT(*)::int as count FROM provider_identity 
            WHERE entity_id = ${email}
        `

        console.log('\n📊 FINAL STATE:')
        console.log('   Email:', verifyCustomer.email)
        console.log('   has_account:', verifyCustomer.has_account)
        console.log('   legacy_customer:', verifyCustomer.metadata?.legacy_customer)
        console.log('   auth_identity count:', verifyAuth[0].count)
        console.log('   provider_identity count:', verifyProvider[0].count)

        if (verifyCustomer.has_account === false &&
            verifyAuth[0].count === 0 &&
            verifyProvider[0].count === 0) {
            console.log('\n✅✅✅ SUCCESS - Account is in CLEAN legacy state')
            console.log('\n📝 Now you can test Case 3 registration from frontend:')
            console.log('   1. Go to /register')
            console.log('   2. Enter email: a.vargas@ecopowertech.com')
            console.log('   3. Enter password + name')
            console.log('   4. Should receive activation email')
        } else {
            console.log('\n❌ WARNING - State not clean!')
        }

    } catch (error) {
        console.error('\n❌ Error:', error)
    } finally {
        await sql.end()
        process.exit(0)
    }
}

forceResetToLegacy()
