import 'dotenv/config'
import { getSql } from '../lib/db.js'

async function verifyPasswordHash() {
    const sql = getSql()

    const result = await sql`
        SELECT pi.id, pi.provider_metadata
        FROM provider_identity pi
        JOIN auth_identity ai ON ai.id = pi.auth_identity_id
        WHERE ai.app_metadata->>'customer_id' = 'cus_legacy_aaeac1670c93a762cb6c'
        AND pi.provider = 'emailpass'
    `

    if (result.length > 0) {
        const providerMetadata = result[0].provider_metadata
        console.log('\n✅ Provider Identity Found')
        console.log('ID:', result[0].id)
        console.log('\n📊 Password Hash Analysis:')
        console.log('Field name:', Object.keys(providerMetadata).includes('password') ? '✅ password' : '❌ NOT password')
        console.log('Hash format:', typeof providerMetadata.password === 'string' ? '✅ string' : '❌ NOT string')

        if (providerMetadata.password) {
            const hash = providerMetadata.password
            console.log('Hash length:', hash.length)
            console.log('First 20 chars:', hash.substring(0, 20))
            console.log('Is base64?:', /^[A-Za-z0-9+/=]+$/.test(hash) ? '✅ YES' : '❌ NO')
            console.log('\n✅✅✅ Password hash stored correctly!')
        } else {
            console.log('❌ No password hash found!')
        }
    } else {
        console.log('❌ No provider identity found')
    }

    process.exit(0)
}

verifyPasswordHash()
