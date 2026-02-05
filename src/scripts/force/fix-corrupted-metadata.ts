import 'dotenv/config'
import { getSql } from '../lib/db.js'

/**
 * EMERGENCY FIX: Repair corrupted customer metadata
 * 
 * Problem: Metadata was saved as character array instead of JSON object
 * Cause: Double JSON serialization (JSON.stringify + ::jsonb cast)
 * 
 * This script:
 * 1. Finds the corrupted customer
 * 2. Reconstructs proper metadata from the character array
 * 3. Saves it correctly using sql.json()
 */

async function fixCorruptedMetadata() {
    const sql = getSql()
    const email = 'a.vargas@ecopowertech.com'

    console.log(`\n🔧 FIXING CORRUPTED METADATA: ${email}\n`)

    try {
        // 1. Get customer with corrupted metadata
        const [customer] = await sql`
            SELECT id, email, metadata FROM customer WHERE email = ${email}
        `

        if (!customer) {
            console.log('❌ Customer not found')
            process.exit(1)
        }

        console.log('✅ Customer found:', customer.id)
        console.log('📦 Current metadata type:', typeof customer.metadata)
        console.log('📦 Current metadata keys:', Object.keys(customer.metadata || {}).length, 'keys')

        // 2. Check if metadata is corrupted (has numeric string keys)
        const isCorrupted = customer.metadata &&
            Object.keys(customer.metadata).some(key => /^\d+$/.test(key))

        if (!isCorrupted) {
            console.log('✅ Metadata is NOT corrupted - looks good!')
            console.log('   Metadata:', JSON.stringify(customer.metadata, null, 2))
            process.exit(0)
        }

        console.log('❌ METADATA IS CORRUPTED - reconstructing...')

        // 3. Reconstruct JSON from character array
        const chars = Object.keys(customer.metadata)
            .sort((a, b) => parseInt(a) - parseInt(b))
            .map(key => customer.metadata[key])
            .join('')

        console.log('📝 Reconstructed string:', chars)

        const reconstructedData = JSON.parse(chars)
        console.log('✅ Parsed JSON:', JSON.stringify(reconstructedData, null, 2))

        // 4. Save corrected metadata using sql.json()
        console.log('\n🔄 Saving corrected metadata...')

        await sql`
            UPDATE customer
            SET metadata = ${sql.json(reconstructedData)}
            WHERE id = ${customer.id}
        `

        console.log('✅ Metadata corrected!')

        // 5. Verify fix
        const [verifyCustomer] = await sql`
            SELECT id, email, metadata FROM customer WHERE id = ${customer.id}
        `

        console.log('\n📊 VERIFIED METADATA:')
        console.log(JSON.stringify(verifyCustomer.metadata, null, 2))

        console.log('\n✅✅✅ SUCCESS - Metadata repaired!')

    } catch (error) {
        console.error('\n❌ Error:', error)
    } finally {
        await sql.end()
        process.exit(0)
    }
}

fixCorruptedMetadata()
