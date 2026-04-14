import postgres from "postgres";
import "dotenv/config";

const EMAIL = "test@ecopowertech.com";
const PASSWORD = "TestAdmin2026!";

async function resetAdminPassword() {
  console.log("🔐 Resetting password for existing admin user...\n");
  console.log(`📧 Email: ${EMAIL}`);
  console.log(`🔑 New Password: ${PASSWORD}\n`);

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Hash password using Node.js native scrypt (same as Medusa uses)
    const crypto = await import("crypto");
    const util = await import("util");
    const scryptAsync = util.promisify(crypto.scrypt);

    console.log("🔐 Hashing password with scrypt...");
    const salt = crypto.randomBytes(16);
    const hashedPassword = (await scryptAsync(PASSWORD, salt, 64)) as Buffer;
    const passwordHash = Buffer.concat([
      Buffer.from("scrypt"),
      Buffer.from([0, 15, 0, 0, 0, 8, 0, 0, 0, 1]), // logN=15, r=8, p=1
      salt,
      hashedPassword,
    ]).toString("base64");

    console.log("✅ Password hashed successfully");

    // Find the auth_identity for this user
    const [authIdentity] = await sql`
            SELECT ai.id
            FROM auth_identity ai
            INNER JOIN provider_identity pi ON pi.auth_identity_id = ai.id
            WHERE pi.entity_id = ${EMAIL}
            AND pi.provider = 'emailpass'
        `;

    if (!authIdentity) {
      console.log("\n❌ No auth_identity found for this email");
      console.log("   The user exists but has no authentication set up.");
      console.log("   Creating auth credentials...\n");

      const authId = "authid_admin_" + Date.now();

      await sql`
                INSERT INTO auth_identity (id, app_metadata)
                VALUES (${authId}, ${sql.json({ role: "admin" })})
            `;

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

      console.log("✅ Auth credentials created!");
    } else {
      // Update existing password
      console.log("📝 Found auth_identity:", authIdentity.id);
      console.log("🔄 Updating password in provider_identity...");

      const result = await sql`
                UPDATE provider_identity
                SET provider_metadata = ${sql.json({ password: passwordHash })}
                WHERE entity_id = ${EMAIL}
                AND provider = 'emailpass'
                RETURNING id
            `;

      if (result.length > 0) {
        console.log("✅ Password updated successfully!");
      } else {
        console.log("❌ Failed to update password");
      }
    }

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("✅ ADMIN LOGIN CREDENTIALS READY");
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

resetAdminPassword();
