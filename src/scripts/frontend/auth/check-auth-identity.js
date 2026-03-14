const { Client } = require('pg')

const email = 'a.vargas@ecopowertech.com'

async function checkAuthIdentity() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    await client.connect()

    console.log('🔍 Verificando auth identity para:', email)
    console.log('')

    // Check provider_identity
    const result = await client.query(`
    SELECT 
      pi.id,
      pi.entity_id,
      pi.provider,
      pi.user_metadata,
      pi.created_at
    FROM provider_identity pi
    WHERE pi.entity_id = $1
  `, [email])

    if (result.rows.length === 0) {
        console.log('❌ No auth identity found')
        await client.end()
        return
    }

    const identity = result.rows[0]

    console.log('✅ Auth Identity encontrado:')
    console.log('   ID:', identity.id)
    console.log('   Provider:', identity.provider)
    console.log('   Created:', identity.created_at)
    console.log('   Has password hash:', !!identity.user_metadata?.password)
    console.log('')

    if (identity.user_metadata?.password) {
        console.log('✅ Password hash existe en user_metadata')
        console.log('   Hash prefix:', identity.user_metadata.password.substring(0, 20) + '...')
    } else {
        console.log('❌ NO hay password hash en user_metadata!')
    }

    await client.end()
}

checkAuthIdentity().catch(err => {
    console.error('Error:', err)
    process.exit(1)
})
