export default async function queryAccounts({ container }: { container: any }) {
    const query = container.resolve("query")

    const emails = ["a.vargas@ecopowertech.com", "alejosvp@gmail.com"];

    const postgres = await import('postgres')
    const sql = postgres.default(process.env.DATABASE_URL!)

    for (const email of emails) {
        console.log(`\n===========================================`)
        console.log(`🔍 Checking account: ${email}`)
        console.log(`===========================================`)

        const { data: customers } = await query.graph({
            entity: "customer",
            filters: { email },
            fields: ["id", "email", "has_account"]
        })

        const customer = customers?.[0]
        console.log("👤 Customer Record:", customer || "NOT FOUND")

        if (!customer) continue;

        const authIdentities = await sql`
        SELECT *
        FROM auth_identity 
        WHERE app_metadata->>'customer_id' = ${customer.id}
           OR app_metadata->>'customer_id' = ${`"${customer.id}"`}
      `
        console.log(`\n🔑 Auth Identities linked to customer (Count: ${authIdentities.length}):`)
        if (authIdentities.length === 0) {
            console.log("  ⚠️ WARNING: No auth identity linked to this customer ID!")
        }

        for (const ai of authIdentities) {
            console.log(`  - AI ID: ${ai.id} | Provider: ${ai.provider_identities ? ai.provider_identities.map((p: any) => p.provider).join(',') : 'none'} | app_metadata:`, JSON.stringify(ai.app_metadata))

            const providerIdentities = await sql`
            SELECT id, provider, user_metadata
            FROM provider_identity 
            WHERE auth_identity_id = ${ai.id}
          `
            console.log(`    🔗 Attached Provider Identities (Count: ${providerIdentities.length}):`)
            for (const pi of providerIdentities) {
                console.log(`      - PI ID: ${pi.id} | Provider: ${pi.provider} | Email in metadata: ${pi.user_metadata?.email}`)
            }
        }

        // Also search by email in provider_identity just in case it's floating
        const floatingPIs = await sql`
        SELECT id, provider, auth_identity_id, user_metadata
        FROM provider_identity
        WHERE provider = 'google'
      `
        let floatingCount = 0;
        for (const pi of floatingPIs) {
            const ud = JSON.stringify(pi.user_metadata || {})
            if (ud.includes(email) && !authIdentities.find(a => a.id === pi.auth_identity_id)) {
                if (floatingCount === 0) console.log(`\n⚠️ ORPHANED/FLOATING Google Identities for ${email}:`)
                console.log(`  - PI ID: ${pi.id} | AuthIdentity ID: ${pi.auth_identity_id}`)
                floatingCount++;
            }
        }
        if (floatingCount === 0) console.log(`\n✅ No orphaned/floating identities found for ${email}`)
    }

    await sql.end()
}
