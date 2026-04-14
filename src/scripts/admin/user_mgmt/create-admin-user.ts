import postgres from "postgres";
import "dotenv/config";

const EMAIL = "test@ecopowertech.com";
const PASSWORD = "TestAdmin2026!";

async function createAdminUser() {
  console.log("🔐 Creating admin user for dashboard access...\n");
  console.log(`📧 Email: ${EMAIL}`);
  console.log(`🔑 Password: ${PASSWORD}\n`);

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Create admin user using Medusa's auth system
    // 1. Create auth_identity
    const authId = "authid_admin_" + Date.now();

    await sql`
            INSERT INTO auth_identity (id, app_metadata)
            VALUES (${authId}, ${sql.json({ role: "admin" })})
        `;

    console.log("✅ Auth identity created:", authId);

    // 2. Create provider_identity with password
    // Import crypto for password hashing
    const crypto = await import("crypto");
    const util = await import("util");
    const scryptAsync = util.promisify(crypto.scrypt);

    const salt = crypto.randomBytes(16);
    const hashedPassword = (await scryptAsync(PASSWORD, salt, 64)) as Buffer;
    const passwordHash = Buffer.concat([
      Buffer.from("scrypt"),
      Buffer.from([0, 15, 0, 0, 0, 8, 0, 0, 0, 1]),
      salt,
      hashedPassword,
    ]).toString("base64");

    await sql`
            INSERT INTO provider_identity (
                id, entity_id, provider, auth_identity_id, provider_metadata
            )
            VALUES (
                ${"provid_admin_" + Date.now()},
                ${EMAIL},
                'emailpass',
                ${authId},
                ${sql.json({ password: passwordHash })}
            )
        `;

    console.log("✅ Provider identity created");

    // 3. Create user record
    const userId = "usr_admin_" + Date.now();
    await sql`
            INSERT INTO "user" (id, email, first_name, last_name)
            VALUES (
                ${userId},
                ${EMAIL},
                'Admin',
                'User'
            )
        `;

    console.log("✅ User record created:", userId);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ ADMIN USER CREATED SUCCESSFULLY!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    console.log("📧 Email:", EMAIL);
    console.log("🔑 Password:", PASSWORD);
    console.log("\n🌐 Login at:");
    console.log(
      "   https://medusa-starter-default-production-b69e.up.railway.app/app/login\n"
    );
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    await sql.end();
  }
}

createAdminUser();
