import postgres from "postgres";
import { loadEnv } from "@medusajs/utils";

loadEnv("development", process.cwd());
const sql = postgres(process.env.DATABASE_URL!);

async function checkAuthIdentity() {
  const email = "a.vargas@ecopowertech.com";

  // Get auth_identity
  const authIdentities = await sql`
        SELECT ai.id, ai.app_metadata, ai.created_at
        FROM auth_identity ai
        JOIN provider_identity pi ON pi.auth_identity_id = ai.id
        WHERE pi.entity_id = ${email}
    `;

  console.log("🔐 Auth Identities for", email, ":", authIdentities.length);

  authIdentities.forEach((auth, idx) => {
    console.log(`\n#${idx + 1}:`);
    console.log("  ID:", auth.id);
    console.log("  app_metadata:", JSON.stringify(auth.app_metadata, null, 2));
    console.log("  created_at:", auth.created_at);
  });

  await sql.end();
}

checkAuthIdentity();
