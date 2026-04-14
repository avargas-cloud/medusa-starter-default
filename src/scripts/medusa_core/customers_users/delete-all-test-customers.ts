import { loadEnv, Modules } from "@medusajs/utils";
import postgres from "postgres";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

const sql = postgres(process.env.DATABASE_URL!);

async function deleteAllTestCustomers() {
  console.log('🔍 Searching for customers with "test" in email...\n');

  try {
    // Find all customers with 'test' in email (case-insensitive)
    const testCustomers = await sql`
            SELECT id, email, first_name, last_name
            FROM customer
            WHERE LOWER(email) LIKE '%test%'
            AND deleted_at IS NULL
            ORDER BY email
        `;

    if (testCustomers.length === 0) {
      console.log("✅ No test customers found\n");
      return;
    }

    console.log(`📋 Found ${testCustomers.length} test customer(s):\n`);
    testCustomers.forEach((customer, index) => {
      console.log(`${index + 1}. ${customer.email} (${customer.id})`);
    });

    console.log("\n🗑️  Deleting test customers...\n");

    let deletedCount = 0;
    let deletedIdentitiesCount = 0;

    for (const customer of testCustomers) {
      try {
        // Delete provider identities first
        const identities = await sql`
                    DELETE FROM provider_identity
                    WHERE auth_identity_id IN (
                        SELECT id FROM auth_identity WHERE app_metadata->>'email' = ${customer.email}
                    ) OR user_metadata->>'email' = ${customer.email}
                    RETURNING id
                `;

        deletedIdentitiesCount += identities.length;

        // Delete auth identity
        await sql`
                    DELETE FROM auth_identity
                    WHERE app_metadata->>'email' = ${customer.email}
                `;

        // Delete customer
        await sql`
                    UPDATE customer
                    SET deleted_at = NOW()
                    WHERE id = ${customer.id}
                `;

        deletedCount++;
        console.log(`  ✅ Deleted: ${customer.email}`);
      } catch (error) {
        console.error(`  ❌ Error deleting ${customer.email}:`, error);
      }
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✅ Deleted ${deletedCount} test customers`);
    console.log(`✅ Deleted ${deletedIdentitiesCount} provider identities`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await sql.end();
  }
}

deleteAllTestCustomers();
