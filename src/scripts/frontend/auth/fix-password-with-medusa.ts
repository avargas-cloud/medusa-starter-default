import { Modules } from "@medusajs/utils";
import { MedusaContainer } from "@medusajs/framework/types";
import { initialize } from "@medusajs/framework";
import postgres from "postgres";
import { loadEnv } from "@medusajs/utils";

loadEnv("development", process.cwd());

async function fixPasswordUsingMedusa() {
  const email = "customtest_1740685200@test.com";
  const password = "Success123!";

  console.log("🔧 Initializing Medusa...");

  try {
    // Initialize Medusa to get access to modules
    const { container } = await initialize({
      database: {
        clientUrl: process.env.DATABASE_URL,
      },
    });

    console.log("✅ Medusa initialized");
    console.log("🔐 Creating new auth identity with correct password hash...");

    const authModule = container.resolve(Modules.AUTH);

    // First, delete existing provider identity to recreate it
    const sql = postgres(process.env.DATABASE_URL!);

    await sql`
            DELETE FROM provider_identity
            WHERE entity_id = ${email}
        `;

    await sql`
            DELETE FROM auth_identity
            WHERE app_metadata->>'customer_id' IN (
                SELECT id FROM customer WHERE email = ${email}
            )
        `;

    console.log("🗑️  Deleted old auth data");

    // Get customer ID
    const [customer] = await sql`
            SELECT id FROM customer WHERE email = ${email}
        `;

    if (!customer) {
      console.log("❌ Customer not found");
      await sql.end();
      return;
    }

    console.log("👤 Customer ID:", customer.id);

    // Create NEW auth identity using Medusa's proper method
    const authIdentity = await authModule.createAuthIdentities({
      provider: "emailpass",
      entity_id: email,
      app_metadata: {
        customer_id: customer.id,
      },
    });

    console.log("✅ Auth identity created:", authIdentity.id);

    // Now create provider identity with PROPER password hash using Medusa's method
    await authModule.updateProviderIdentities({
      auth_identity_id: authIdentity.id,
      provider_metadata: {
        password,
      },
    });

    console.log("✅ Password set successfully!");
    console.log("🎯 Customer can now login with:");
    console.log("   Email:", email);
    console.log("   Password:", password);

    await sql.end();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

fixPasswordUsingMedusa();
