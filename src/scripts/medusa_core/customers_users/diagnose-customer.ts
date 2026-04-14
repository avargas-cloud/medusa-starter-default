import "dotenv/config";
import { getSql } from "../lib/db.js";

async function checkCustomer() {
  const sql = getSql();
  const email = "a.vargas@ecopowertech.com";

  // Check customer
  const customers = await sql`
        SELECT id, email, has_account, created_at, deleted_at, 
               metadata
        FROM customer
        WHERE email = ${email}
    `;

  console.log("\n=== CUSTOMER RECORD ===");
  if (customers.length === 0) {
    console.log("❌ NO EXISTE - El customer fue eliminado de la DB");
  } else {
    const c = customers[0];
    console.log("✅ EXISTE en la base de datos");
    console.log("\nID:", c.id);
    console.log("Email:", c.email);
    console.log("has_account:", c.has_account);
    console.log("deleted_at:", c.deleted_at || "null (NO eliminado)");
    console.log("created_at:", c.created_at);

    const metadata = c.metadata;
    console.log("\nMetadata:");
    console.log("  legacy_customer:", metadata?.legacy_customer);
    console.log("  reset_token:", metadata?.reset_token ? "presente" : "null");
    console.log(
      "  activation_token:",
      metadata?.activation_token ? "presente" : "null"
    );
  }

  // Check auth records
  console.log("\n=== AUTH RECORDS ===");
  const authRecords = await sql`
        SELECT ai.id as auth_id, ai.app_metadata,
               pi.id as provider_id, pi.provider
        FROM auth_identity ai
        LEFT JOIN provider_identity pi ON pi.auth_identity_id = ai.id
        WHERE ai.app_metadata->>'customer_id' = ${customers[0]?.id || "none"}
    `;

  if (authRecords.length === 0) {
    console.log("❌ Sin auth_identity (estado legacy correcto)");
  } else {
    console.log("✅ Tiene auth_identity:");
    authRecords.forEach((r) => {
      console.log(`  - auth_id: ${r.auth_id}`);
      console.log(`  - provider_id: ${r.provider_id}`);
      console.log(`  - provider: ${r.provider}`);
    });
  }

  process.exit(0);
}

checkCustomer();
