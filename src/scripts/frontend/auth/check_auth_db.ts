import { loadEnv } from "@medusajs/utils";
import postgres from "postgres";
loadEnv("development", process.cwd());

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("❌ DATABASE_URL is missing");
  process.exit(1);
}

const sql = postgres(dbUrl);

(async () => {
  try {
    console.log("🔍 Checking database for a.vargas@ecopowertech.com...");

    // 1. Check Customer
    const customers =
      await sql`SELECT id, has_account FROM customer WHERE email = 'a.vargas@ecopowertech.com'`;
    if (customers.length === 0) {
      console.log("❌ Customer NOT FOUND");
      await sql.end();
      return;
    }
    const customer = customers[0];
    console.log(
      `✅ Customer FOUND: ${customer.id} (has_account: ${customer.has_account})`
    );

    // 2. Check Auth Identity (via app_metadata)
    const auths =
      await sql`SELECT id, app_metadata FROM auth_identity WHERE app_metadata->>'customer_id' = ${customer.id}`;
    if (auths.length > 0) {
      console.log(`✅ Auth Identity FOUND by customer_id: ${auths[0].id}`);
    } else {
      console.log("❌ Auth Identity NOT FOUND by customer_id lookup");
    }

    // 3. Check Provider Identity
    const provs =
      await sql`SELECT id, provider, auth_identity_id, provider_metadata FROM provider_identity WHERE entity_id = 'a.vargas@ecopowertech.com'`;
    if (provs.length > 0) {
      const p = provs[0];
      console.log(`✅ Provider Identity FOUND: ${p.id}`);
      console.log(`   Provider: ${p.provider}`);
      console.log(`   Linked Auth Identity ID: ${p.auth_identity_id}`);
      console.log(`   Raw Metadata: ${JSON.stringify(p.provider_metadata)}`);

      // Check if the linked auth identity exists by ID
      if (p.auth_identity_id) {
        const linkedAuth =
          await sql`SELECT id FROM auth_identity WHERE id = ${p.auth_identity_id}`;
        console.log(
          `   -> Linked Auth Identity lookup: ${linkedAuth.length > 0 ? "✅ FOUND" : "❌ NOT FOUND (Orphaned)"}`
        );
      }
    } else {
      console.log("❌ Provider Identity MISSING");
    }

    await sql.end();
  } catch (e) {
    console.error("❌ Error checking DB:", e);
    await sql.end();
  }
})();
