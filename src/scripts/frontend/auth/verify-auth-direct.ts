import { getSql } from "../lib/db";

async function main() {
  const sql = getSql();

  const authIdentities = await sql`
        SELECT ai.id, ai.app_metadata, ai.created_at
        FROM auth_identity ai
        WHERE ai.app_metadata->>'customer_id' = 'cus_legacy_aaeac1670c93a762cb6c'
    `;

  console.log("\n🔍 Auth Identities found:", authIdentities.length);
  authIdentities.forEach((ai, i) => {
    console.log(`\n${i + 1}. ID: ${ai.id}`);
    console.log(`   Created: ${ai.created_at}`);
    console.log(`   Metadata:`, JSON.stringify(ai.app_metadata));
  });

  const providers = await sql`
        SELECT id, entity_id, provider, auth_identity_id, created_at
        FROM provider_identity
        WHERE entity_id = 'a.vargas@ecopowertech.com' AND provider = 'emailpass'
        ORDER BY created_at DESC
        LIMIT 5
    `;

  console.log(`\n🔍 Provider Identities found: ${providers.length}`);
  providers.forEach((p, i) => {
    console.log(`\n${i + 1}. ID: ${p.id}`);
    console.log(`   Auth Identity ID: ${p.auth_identity_id}`);
    console.log(`   Created: ${p.created_at}`);
  });
}

main().then(() => process.exit(0));
