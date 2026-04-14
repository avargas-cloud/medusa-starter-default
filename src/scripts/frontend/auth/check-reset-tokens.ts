import "dotenv/config";
import { getSql } from "../lib/db.js";

async function checkResetTokens() {
  const sql = getSql();

  const result = await sql`
        SELECT email, 
               metadata->>'reset_token' as reset_token,
               metadata->>'reset_expires' as expires
        FROM customer
        WHERE metadata->>'reset_token' IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 5
    `;

  console.log("\n=== Customers with Reset Tokens ===");
  if (result.length === 0) {
    console.log("❌ No reset tokens found in database");
  } else {
    result.forEach((r) => {
      console.log(`\nEmail: ${r.email}`);
      console.log(`Token: ${r.reset_token?.substring(0, 20)}...`);
      console.log(`Expires: ${r.expires}`);
    });
  }

  process.exit(0);
}

checkResetTokens();
