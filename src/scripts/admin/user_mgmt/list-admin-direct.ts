import postgres from "postgres";
import "dotenv/config";

async function listAdminUsers() {
  console.log("🔍 Searching for admin users in production...\n");

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Query auth_identity table for admin users
    const users = await sql`
            SELECT 
                ai.id,
                ai.provider_metadata->>'entity_id' as email,
                ai.created_at,
                ai.app_metadata
            FROM auth_identity ai
            WHERE ai.provider = 'emailpass'
            AND (
                ai.provider_metadata->>'entity_id' LIKE 'test%'
                OR ai.provider_metadata->>'entity_id' LIKE '%admin%'
                OR ai.provider_metadata->>'entity_id' LIKE 'a.vargas%'
            )
            ORDER BY ai.created_at DESC
        `;

    if (users.length === 0) {
      console.log("⚠️  No admin users found");
      console.log("\nSearching for ANY users...\n");

      const allUsers = await sql`
                SELECT 
                    ai.id,
                    ai.provider_metadata->>'entity_id' as email,
                    ai.created_at
                FROM auth_identity ai
                WHERE ai.provider = 'emailpass'
                ORDER BY ai.created_at DESC
                LIMIT 10
            `;

      console.log(`Found ${allUsers.length} total users:`);
      allUsers.forEach((user, i) => {
        console.log(`${i + 1}. ${user.email}`);
      });
    } else {
      console.log(`✅ Found ${users.length} admin user(s):\n`);
      users.forEach((user, index) => {
        console.log(`${index + 1}. Email: ${user.email}`);
        console.log(`   ID: ${user.id}`);
        console.log(`   Created: ${user.created_at}`);
        console.log("");
      });
    }
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await sql.end();
  }
}

listAdminUsers();
