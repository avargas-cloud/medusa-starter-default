import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"
import * as crypto from 'crypto'

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function verifyPassword() {
    const email = 'customtest_1740685200@test.com'
    const password = 'Success123!'

    // Get provider identity with password hash
    const [pi] = await sql`
        SELECT pi.provider_metadata
        FROM provider_identity pi
        JOIN auth_identity ai ON ai.id = pi.auth_identity_id
        WHERE pi.entity_id = ${email}
    `

    if (!pi) {
        console.log('❌ No provider identity found')
        await sql.end()
        return
    }

    console.log('Provider metadata:', JSON.stringify(pi.provider_metadata, null, 2))

    const hash = pi.provider_metadata?.password_hash
    if (!hash) {
        console.log('❌ No password hash found')
        await sql.end()
        return
    }

    console.log('\n🔍 Hash found:', hash.substring(0, 50) + '...')
    console.log('🔍 Hash length:', hash.length)
    console.log('🔍 Hash algorithm:', hash.substring(0, 10))

    await sql.end()
}

verifyPassword()
