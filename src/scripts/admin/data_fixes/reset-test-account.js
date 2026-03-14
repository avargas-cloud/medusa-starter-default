const { Client } = require('pg')

const email = 'a.vargas@ecopowertech.com'

const client = new Client({
    connectionString: process.env.DATABASE_URL
})

async function resetAccount() {
    await client.connect()

    console.log('🔄 Reseteando cuenta:', email)
    console.log('')

    // Delete auth identities
    const deleteAuth = await client.query(`
    DELETE FROM provider_identity WHERE entity_id = $1
  `, [email])

    console.log('✅ Auth identities eliminadas:', deleteAuth.rowCount)

    // Reset customer to legacy virgin state
    const updateCustomer = await client.query(`
    UPDATE customer 
    SET has_account = false,
        metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb) - 'activated_at',
          '{legacy_customer}',
          'true'
        )
    WHERE email = $1
    RETURNING id, email, has_account, metadata
  `, [email])

    const customer = updateCustomer.rows[0]

    console.log('✅ Customer reseteado:')
    console.log('   → has_account:', customer.has_account)
    console.log('   → legacy_customer:', customer.metadata?.legacy_customer)
    console.log('   → activated_at:', customer.metadata?.activated_at || '(removed)')
    console.log('')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('✅ CUENTA EN ESTADO LEGACY VIRGEN')
    console.log('   → Lista para probar activación')
    console.log('   → Ejecuta: node src/scripts/test-legacy-customer.mjs')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    await client.end()
}

resetAccount().catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
})
