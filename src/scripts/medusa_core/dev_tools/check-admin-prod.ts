import postgres from "postgres";
import "dotenv/config";

async function checkAdminUsers() {
  console.log("🔍 Checking admin access for production dashboard...\n");

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // First check auth_identity structure
    const authIdentities = await sql`
            SELECT id, app_metadata, created_at, updated_at
            FROM auth_identity
            ORDER BY created_at DESC
            LIMIT 5
        `;

    console.log(`Found ${authIdentities.length} auth identities:\n`);
    authIdentities.forEach((auth, i) => {
      console.log(`${i + 1}. Auth ID: ${auth.id}`);
      console.log(`   Metadata:`, auth.app_metadata);
      console.log(`   Created: ${auth.created_at}`);
      console.log("");
    });

    // Check provider_identity for emails
    const providers = await sql`
            SELECT id, entity_id, provider, auth_identity_id, created_at
            FROM provider_identity
            WHERE provider = 'emailpass'
            ORDER BY created_at DESC
            LIMIT 10
        `;

    console.log(`\nFound ${providers.length} provider identities:\n`);
    providers.forEach((prov, i) => {
      console.log(`${i + 1}. Email: ${prov.entity_id}`);
      console.log(`   Auth ID: ${prov.auth_identity_id}`);
      console.log(`   Created: ${prov.created_at}`);
      console.log("");
    });
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await sql.end();
  }
}

checkAdminUsers();
