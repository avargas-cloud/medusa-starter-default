import postgres from "postgres";
import { loadEnv } from "@medusajs/utils";

loadEnv("development", process.cwd());
const sql = postgres(process.env.DATABASE_URL!);

async function verifyActivation() {
  const email = "a.vargas@ecopowertech.com";

  // Check customer
  const [customer] = await sql`
        SELECT id, email, has_account, metadata
        FROM customer
        WHERE email = ${email}
    `;

  console.log("📋 Customer Status:");
  console.log("  Email:", customer.email);
  console.log("  has_account:", customer.has_account);
  console.log("  legacy_customer:", customer.metadata?.legacy_customer);
  console.log("  activated_at:", customer.metadata?.activated_at);

  // Check auth_identity
  const authIdentities = await sql`
        SELECT id, provider
        FROM auth_identity
        WHERE app_metadata->>'customer_id' = ${customer.id}
    `;

  console.log("\n🔐 Auth Identities:", authIdentities.length);
  authIdentities.forEach((auth) => {
    console.log("  ID:", auth.id, "Provider:", auth.provider);
  });

  // Check provider_identity
  const providerIdentities = await sql`
        SELECT entity_id, provider
        FROM provider_identity
        WHERE entity_id = ${email}
    `;

  console.log("\n🔑 Provider Identities:", providerIdentities.length);
  providerIdentities.forEach((prov) => {
    console.log("  Email:", prov.entity_id, "Provider:", prov.provider);
  });

  if (customer.has_account && authIdentities.length > 0) {
    console.log("\n✅ ¡ACTIVACIÓN COMPLETADA CORRECTAMENTE!");
    console.log("\n📝 Ahora puedes hacer login con:");
    console.log(`curl -X POST http://localhost:9000/store/auth/login \\
  -H "Content-Type: application/json" \\
  -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" \\
  -d '{
    "email": "${email}",
    "password": "NewPassword123!"
  }'`);
  }

  await sql.end();
}

verifyActivation();
