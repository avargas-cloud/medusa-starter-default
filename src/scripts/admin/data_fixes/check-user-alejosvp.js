import { Client } from 'pg'
import 'dotenv/config'

const checkUserExists = async () => {
    const email = 'alejosvp@gmail.com'

    const client = new Client({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await client.connect()
        console.log(`🔍 Buscando registros de: ${email}\n`)

        // Check customer table
        const customerResult = await client.query(
            `SELECT id, email, has_account, created_at, metadata FROM customer WHERE email = $1`,
            [email]
        )
        console.log('📊 CUSTOMER TABLE:')
        if (customerResult.rows.length > 0) {
            console.log('   ⚠️  ENCONTRADO:', customerResult.rows[0])
        } else {
            console.log('   ✅ No existe\n')
        }

        // Check provider_identity table
        const identityResult = await client.query(
            `SELECT id, entity_id, provider, created_at FROM provider_identity WHERE entity_id = $1`,
            [email]
        )
        console.log('📊 PROVIDER_IDENTITY TABLE:')
        if (identityResult.rows.length > 0) {
            console.log('   ⚠️  ENCONTRADO:', identityResult.rows)
        } else {
            console.log('   ✅ No existe\n')
        }

        // Check auth_identity table (Medusa v2)
        const authIdentityResult = await client.query(
            `SELECT id, entity_id, provider_identities FROM auth_identity WHERE entity_id = $1`,
            [email]
        )
        console.log('📊 AUTH_IDENTITY TABLE:')
        if (authIdentityResult.rows.length > 0) {
            console.log('   ⚠️  ENCONTRADO:', authIdentityResult.rows)
        } else {
            console.log('   ✅ No existe\n')
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        if (customerResult.rows.length === 0 && identityResult.rows.length === 0 && authIdentityResult.rows.length === 0) {
            console.log('✅ USUARIO COMPLETAMENTE ELIMINADO')
            console.log('   No hay registros en ninguna tabla')
        } else {
            console.log('⚠️  USUARIO AÚN TIENE REGISTROS')
            console.log('   Necesita limpieza adicional')
        }
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

    } catch (error) {
        console.error('❌ Error:', error.message)
    } finally {
        await client.end()
    }
}

checkUserExists()
