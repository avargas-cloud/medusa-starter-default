import postgres from 'postgres'
import { loadEnv } from '@medusajs/framework/utils'

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function debugLogin() {
    const email = 'a.vargas@ecopowertech.com'

    console.log('🔍 Debugging login for:', email)

    // Check customer
    const [customer] = await sql`
        SELECT id, email, has_account, deleted_at
        FROM customer
        WHERE email = ${email}
    `

    console.log('\n📋 Customer:')
    console.log('  ID:', customer?.id)
    console.log('  Email:', customer?.email)
    console.log('  has_account:', customer?.has_account)
    console.log('  deleted_at:', customer?.deleted_at)

    // Check auth_identity
    const [authIdentity] = await sql`
        SELECT id, provider, app_metadata, deleted_at
        FROM auth_identity
        WHERE app_metadata->>'customer_id' = ${customer?.id}
    `

    console.log('\n🔐 Auth Identity:')
    console.log('  ID:', authIdentity?.id)
    console.log('  Provider:', authIdentity?.provider)
    console.log('  customer_id in app_metadata:', authIdentity?.app_metadata?.customer_id)
    console.log('  deleted_at:', authIdentity?.deleted_at)

    // Check provider_identity
    const [providerIdentity] = await sql`
        SELECT entity_id, provider, deleted_at
        FROM provider_identity
        WHERE entity_id = ${email}
    `

    console.log('\n🔑 Provider Identity:')
    console.log('  entity_id:', providerIdentity?.entity_id)
    console.log('  Provider:', providerIdentity?.provider)
    console.log('  deleted_at:', providerIdentity?.deleted_at)

    await sql.end()
}

debugLogin()
