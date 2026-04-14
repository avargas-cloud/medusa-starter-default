import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

async function checkRecentLogins() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await db.connect();

    // 1. Check if ANY provider_identity was created today
    const res1 = await db.query(`
      SELECT *
      FROM provider_identity
      WHERE created_at > NOW() - INTERVAL '6 hours'
      ORDER BY created_at DESC;
    `);
    console.log("✅ Provider Identities creados en las últimas 6 horas:");
    console.log(JSON.stringify(res1.rows, null, 2));

    // 2. Check ANY auth_identity for your email or customer_id
    const res2 = await db.query(`
      SELECT *
      FROM auth_identity
      WHERE app_metadata::text LIKE '%alejosvp@gmail.com%' 
         OR app_metadata::text LIKE '%cus_01KJ5WCMSB3HWW3Y7MDQR95YC2%';
    `);
    console.log(
      "\n✅ Identidad Auth atada a tu correo o customer_id (auth_identity):"
    );
    console.log(JSON.stringify(res2.rows, null, 2));
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await db.end();
  }
}

checkRecentLogins();
