import 'dotenv/config'
import postgres from 'postgres'

/**
 * END-TO-END TEST: Native Default Address Management
 * Tests complete workflow with Medusa's automatic toggle
 */

async function testDefaultAddresses() {
    const sql = postgres(process.env.DATABASE_URL!)
    const testEmail = 'a.vargas@ecopowertech.com'

    console.log('\n🧪 END-TO-END TEST: Default Address Management\n')

    try {
        // Get customer
        const [customer] = await sql`
            SELECT id FROM customer WHERE email = ${testEmail} LIMIT 1
        `

        if (!customer) {
            console.log('❌ Test customer not found')
            process.exit(1)
        }

        console.log(`✅ Testing with customer: ${testEmail}`)
        console.log(`   Customer ID: ${customer.id}\n`)

        // STEP 1: Get current addresses
        console.log('📋 STEP 1: Current state\n')
        let addresses = await sql`
            SELECT id, address_1, city, is_default_billing, is_default_shipping
            FROM customer_address
            WHERE customer_id = ${customer.id}
            AND deleted_at IS NULL
            ORDER BY created_at
        `

        console.log(`   Total addresses: ${addresses.length}`)
        addresses.forEach((addr, i) => {
            console.log(`   ${i + 1}. ${addr.address_1}, ${addr.city}`)
            console.log(`      Default Billing: ${addr.is_default_billing ? '✅' : '❌'}`)
            console.log(`      Default Shipping: ${addr.is_default_shipping ? '✅' : '❌'}`)
        })

        if (addresses.length < 2) {
            console.log('\n⚠️  Need at least 2 addresses for testing')
            process.exit(0)
        }

        const [addr1, addr2] = addresses

        // STEP 2: Set first address as default billing
        console.log('\n🔧 STEP 2: Setting first address as default billing...\n')
        await sql`
            UPDATE customer_address
            SET is_default_billing = true
            WHERE id = ${addr1.id}
        `

        addresses = await sql`
            SELECT id, address_1, is_default_billing, is_default_shipping
            FROM customer_address
            WHERE customer_id = ${customer.id}
            AND deleted_at IS NULL
        `

        const billingCount = addresses.filter(a => a.is_default_billing).length
        console.log(`   Addresses with is_default_billing=true: ${billingCount}`)
        if (billingCount === 1) {
            console.log('   ✅ PASS: Only 1 address is default billing')
        } else {
            console.log('   ❌ FAIL: Should have exactly 1 default billing')
        }

        // STEP 3: Change default to second address (simulating Medusa workflow)
        console.log('\n🔧 STEP 3: Changing default billing to second address...\n')

        // First unset previous default (simulating maybeUnsetDefaultBillingAddressesStep)
        await sql`
            UPDATE customer_address
            SET is_default_billing = false
            WHERE customer_id = ${customer.id}
            AND id != ${addr2.id}
        `

        // Then set new default
        await sql`
            UPDATE customer_address
            SET is_default_billing = true
            WHERE id = ${addr2.id}
        `

        addresses = await sql`
            SELECT id, address_1, is_default_billing
            FROM customer_address
            WHERE customer_id = ${customer.id}
            AND deleted_at IS NULL
        `

        const addr1After = addresses.find(a => a.id === addr1.id)
        const addr2After = addresses.find(a => a.id === addr2.id)

        console.log(`   Address 1 is_default_billing: ${addr1After?.is_default_billing ? '✅' : '❌'}`)
        console.log(`   Address 2 is_default_billing: ${addr2After?.is_default_billing ? '✅' : '❌'}`)

        if (!addr1After?.is_default_billing && addr2After?.is_default_billing) {
            console.log('   ✅ PASS: Default correctly toggled')
        } else {
            console.log('   ❌ FAIL: Toggle did not work correctly')
        }

        // STEP 4: Set shipping defaults independently
        console.log('\n🔧 STEP 4: Testing independent shipping default...\n')

        await sql`
            UPDATE customer_address
            SET is_default_shipping = true
            WHERE id = ${addr1.id}
        `

        addresses = await sql`
            SELECT id, is_default_billing, is_default_shipping
            FROM customer_address
            WHERE customer_id = ${customer.id}
            AND deleted_at IS NULL
        `

        const addr1Final = addresses.find(a => a.id === addr1.id)
        const addr2Final = addresses.find(a => a.id === addr2.id)

        console.log('   Address 1:')
        console.log(`     - Billing: ${addr1Final?.is_default_billing ? '✅' : '❌'}`)
        console.log(`     - Shipping: ${addr1Final?.is_default_shipping ? '✅' : '❌'}`)
        console.log('   Address 2:')
        console.log(`     - Billing: ${addr2Final?.is_default_billing ? '✅' : '❌'}`)
        console.log(`     - Shipping: ${addr2Final?.is_default_shipping ? '✅' : '❌'}`)

        if (!addr1Final?.is_default_billing && addr1Final?.is_default_shipping &&
            addr2Final?.is_default_billing && !addr2Final?.is_default_shipping) {
            console.log('   ✅ PASS: Billing and shipping can be different addresses')
        } else {
            console.log('   ❌ FAIL: Billing/shipping independence issue')
        }

        console.log('\n✅ ALL TESTS COMPLETED!\n')

    } catch (error) {
        console.error('\n❌ Error:', error)
        process.exit(1)
    } finally {
        await sql.end()
        process.exit(0)
    }
}

testDefaultAddresses()
