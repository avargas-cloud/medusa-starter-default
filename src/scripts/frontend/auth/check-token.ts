import "dotenv/config";
import { getSql } from "../lib/db.js";

async function checkToken() {
  const sql = getSql();
  const token = process.argv[2];

  if (!token) {
    console.log("Usage: npx tsx check-token.ts <token>");
    process.exit(1);
  }

  const result = await sql`
        SELECT email, has_account, 
               metadata->>'reset_token' as reset_token,
               metadata->>'reset_expires' as reset_expires,
               metadata->>'legacy_customer' as legacy
        FROM customer
        WHERE metadata->>'reset_token' = ${token}
    `;

  if (result.length > 0) {
    console.log("\n✅ Token encontrado:");
    console.log("Email:", result[0].email);
    console.log("has_account:", result[0].has_account);
    console.log("legacy_customer:", result[0].legacy);
    console.log("Expires:", result[0].reset_expires);
    const expired = new Date() > new Date(result[0].reset_expires);
    console.log("Expirado?", expired ? "❌ SÍ" : "✅ NO");

    if (result[0].has_account === false || result[0].has_account === "false") {
      console.log(
        "\n⚠️  PROBLEMA: Este usuario NO tiene cuenta (has_account=false)"
      );
      console.log("   Password Reset solo funciona para usuarios CON cuenta.");
      console.log("   Este usuario debe usar el flujo de ACTIVACIÓN (Case 3).");
    }
  } else {
    console.log("❌ Token NO encontrado en DB");
  }

  process.exit(0);
}

checkToken();
