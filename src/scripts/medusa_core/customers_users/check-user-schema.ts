import postgres from "postgres";
import "dotenv/config";

async function checkUserTables() {
  console.log("🔍 Checking user table structure...\n");

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Check if there's a separate admin table or role field
    const userTableInfo = await sql`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'user'
            ORDER BY ordinal_position
        `;

    console.log("User table columns:");
    userTableInfo.forEach((col) => {
      console.log(`  - ${col.column_name}: ${col.data_type}`);
    });

    // Check existing users
    const users = await sql`
            SELECT id, email, first_name, last_name, metadata
            FROM "user"
            LIMIT 5
        `;

    console.log("\nExisting users:");
    users.forEach((user) => {
      console.log(`  - ${user.email} (${user.id})`);
      console.log(`    Metadata:`, user.metadata);
    });
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await sql.end();
  }
}

checkUserTables();
