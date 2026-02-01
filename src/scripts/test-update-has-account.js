const { Client } = require('pg')

const email = 'a.vargas@ecopowertech.com'

async function testUpdateHasAccount() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    await client.connect()

    console.log('🧪 Testing has_account update methods...')
    console.log('')

    // Check initial state
    let result = await client.query('SELECT id, email, has_account FROM customer WHERE email = $1', [email])
    const customerId = result.rows[0].id

    console.log('📊 BEFORE:')
    console.log('   has_account:', result.rows[0].has_account)
    console.log('')

    // Method 1: Direct SQL UPDATE
    console.log('🔧 Method 1: Direct SQL UPDATE')
    try {
        await client.query('UPDATE customer SET has_account = true WHERE id = $1', [customerId])
        console.log('   ✅ UPDATE executed')

        // Verify
        result = await client.query('SELECT has_account FROM customer WHERE id = $1', [customerId])
        console.log('   Result: has_account =', result.rows[0].has_account)
    } catch (err) {
        console.log('   ❌ Error:', err.message)
    }
    console.log('')

    // Reset to false
    await client.query('UPDATE customer SET has_account = false WHERE id = $1', [customerId])

    // Method 2: Using RETURNING clause
    console.log('🔧 Method 2: UPDATE with RETURNING')
    try {
        result = await client.query(
            'UPDATE customer SET has_account = true WHERE id = $1 RETURNING id, has_account',
            [customerId]
        )
        console.log('   ✅ UPDATE executed')
        console.log('   Result: has_account =', result.rows[0].has_account)
    } catch (err) {
        console.log('   ❌ Error:', err.message)
    }
    console.log('')

    // Final verification
    result = await client.query('SELECT id, email, has_account FROM customer WHERE email = $1', [email])
    console.log('📊 FINAL STATE:')
    console.log('   has_account:', result.rows[0].has_account)
    console.log('')

    if (result.rows[0].has_account === true) {
        console.log('✅ SUCCESS! has_account can be updated directly via SQL')
        console.log('   → This method works and should be used in the activation endpoint')
    } else {
        console.log('❌ FAILED! has_account did not update')
    }

    await client.end()
}

testUpdateHasAccount().catch(err => {
    console.error('Error:', err)
    process.exit(1)
})
