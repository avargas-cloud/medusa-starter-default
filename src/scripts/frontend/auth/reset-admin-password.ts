import { loadEnv } from "@medusajs/utils";
import postgres from "postgres";
import { scryptSync, randomBytes } from "crypto";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

const email = process.env.email || "a.vargas@ecopowertech.com";
const newPassword = process.env.password || "admin123";

// Medusa v2 uses scrypt, but Node.js has memory limits
// Using lower N to avoid memory limit exceeded error
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  // Using N=16384 instead of 32768 to avoid memory issues
  const hash = scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  }).toString("hex");
  return `${salt}:${hash}`;
}

async function resetAdminPassword() {
  console.log(`🔑 Resetting password for: ${email}`);
  console.log(`🆕 New password will be: ${newPassword}\n`);

  const sql = postgres(process.env.DATABASE_URL!);

  try {
    // Hash the new password
    const hashedPassword = hashPassword(newPassword);

    // Update auth_identity table
    const result = await sql`
            UPDATE auth_identity
            SET provider_metadata = jsonb_set(
                COALESCE(provider_metadata, '{}'::jsonb),
                '{password}',
                to_jsonb(${hashedPassword}::text)
            )
            WHERE entity_id = ${email}
            AND provider = 'emailpass'
            RETURNING id, entity_id
        `;

    if (result.length === 0) {
      console.log("❌ User not found with email:", email);
      console.log("\nMake sure the email is correct.");
    } else {
      console.log("✅ Password updated successfully!");
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("📧 Email:", email);
      console.log("🔑 Password:", newPassword);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      console.log(
        "🌐 Login at: https://medusa-starter-default-production-b69e.up.railway.app/app/login"
      );
    }
  } catch (error) {
    console.error("❌ Error updating password:", error);
  } finally {
    await sql.end();
  }
}

resetAdminPassword();
