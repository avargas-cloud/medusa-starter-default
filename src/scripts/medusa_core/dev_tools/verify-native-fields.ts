import 'dotenv/config'
import postgres from 'postgres'

/**
 * Verification Script: Check native billing_address_id field
 */

async function verifyNativeFields() {
    const sql = postgres(process.env.DATABASE_URL!)

    console.log('\n🔍 VERIFICATION: Native Default Address Fields\n')

    try {
        // 1. Check if billing_address_id column exists in customer table
        console.log('1️⃣  Checking customer table schema...')
        const [schema] = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'customer' 
            AND column_name IN ('billing_address_id', 'id', 'email')
            ORDER BY column_name
        `

        if (!schema) {
            console.log('❌ Could not read customer table schema')
            process.exit(1)
        }

        const columns = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'customer' 
            AND column_name IN ('billing_address_id', 'metadata')
        `

        console.log('   Found columns:')
        columns.forEach(col => {
            console.log(`   - ${col.column_name}: ${col.data_type}`)
        })

        const hasBillingAddressId = columns.some(c => c.column_name === 'billing_address_id')
        const hasMetadata = columns.some(c => c.column_name === 'metadata')

        if (!hasBillingAddressId) {
            console.log('\n❌ CRITICAL: billing_address_id column does NOT exist!')
            console.log('   This is a NATIVE Medusa v2 field that should exist.')
            process.exit(1)
        }

        if (!hasMetadata) {
            console.log('\n❌ CRITICAL: metadata column does NOT exist!')
            process.exit(1)
        }

        console.log('\n✅ Schema verified: billing_address_id and metadata exist\n')

        // 2. Test with actual customer
        console.log('2️⃣  Testing with real customer...')
        const [customer] = await sql`
            SELECT id, email, billing_address_id, metadata
            FROM customer
            WHERE email = 'a.vargas@ecopowertech.com'
            LIMIT 1
        `

        if (!customer) {
            console.log('   ⚠️  Test customer not found')
        } else {
            console.log(`   Customer: ${customer.email}`)
            console.log(`   billing_address_id: ${customer.billing_address_id || 'NULL'}`)
            console.log(`   metadata.default_shipping_address_id: ${customer.metadata?.default_shipping_address_id || 'NULL'}`)
        }

        // 3. Get addresses
        if (customer) {
            const addresses = await sql`
                SELECT id, address_1, city, customer_id
                FROM address
                WHERE customer_id = ${customer.id}
                LIMIT 5
            `

            console.log(`\n   Customer has ${addresses.length} address(es):`)
            addresses.forEach((addr, i) => {
                const isBilling = addr.id === customer.billing_address_id
                const isShipping = addr.id === customer.metadata?.default_shipping_address_id
                console.log(`   ${i + 1}. ${addr.address_1}, ${addr.city}`)
                console.log(`      ID: ${addr.id}`)
                console.log(`      Default Billing: ${isBilling ? '✅ YES' : '❌ no'}`)
                console.log(`      Default Shipping: ${isShipping ? '✅ YES' : '❌ no'}`)
            })
        }

        console.log('\n✅ All native fields verified successfully!\n')

    } catch (error) {
        console.error('\n❌ Error:', error)
        process.exit(1)
    } finally {
        await sql.end()
        process.exit(0)
    }
}

verifyNativeFields()
