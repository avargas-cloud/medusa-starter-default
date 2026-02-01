const { Client } = require('pg')

const email = 'a.vargas@ecopowertech.com'

const client = new Client({
    connectionString: process.env.DATABASE_URL
})

async function checkAccount() {
    await client.connect()

    console.log('🔍 Verificando estado de:', email)
    console.log('')

    // Check customer
    const customerRes = await client.query(`
    SELECT id, email, has_account, metadata
    FROM customer
    WHERE email = $1
  `, [email])

    const customer = customerRes.rows[0]

    if (!customer) {
        console.log('❌ Customer no encontrado')
        await client.end()
        return
    }

    console.log('📧 Email:', customer.email)
    console.log('🆔 ID:', customer.id)
    console.log('🔐 has_account:', customer.has_account)
    console.log('🏷️  legacy_customer:', customer.metadata?.legacy_customer)
    console.log('📅 activated_at:', customer.metadata?.activated_at)
    console.log('')

    // Check auth
    const authRes = await client.query(`
    SELECT COUNT(*) as count
    FROM provider_identity
    WHERE entity_id = $1
  `, [email])

    const authCount = parseInt(authRes.rows[0].count)
    console.log('🔑 Auth identities existentes:', authCount)
    console.log('')

    // Status summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    if (customer.has_account === false && customer.metadata?.legacy_customer && authCount === 0) {
        console.log('✅ ESTADO: LEGACY VIRGEN')
        console.log('   → Lista para activar')
        console.log('   → Ejecuta: node src/scripts/test-legacy-customer.mjs')
    } else {
        console.log('❌ ESTADO: YA ACTIVADA')
        console.log('   → has_account =', customer.has_account)
        console.log('   → auth_count =', authCount)
        console.log('   → Necesita reset para probar de nuevo')
        console.log('   → Ejecuta: node src/scripts/reset-test-account.js')
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    await client.end()
}

checkAccount().catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
})
