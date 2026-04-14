import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function checkAuthIdentities() {
  const email = "alejosvp@gmail.com";

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log(`🔍 Verificando restos para: ${email}\n`);

    // Check provider identities
    const identities = await client.query(
      `SELECT * FROM provider_identity WHERE entity_id = $1`,
      [email]
    );

    console.log(`📌 Provider identities encontradas: ${identities.rowCount}`);
    if (identities.rowCount > 0) {
      console.log(identities.rows);

      // Delete them
      await client.query(`DELETE FROM provider_identity WHERE entity_id = $1`, [
        email,
      ]);
      console.log("✅ Provider identities eliminadas");
    }

    // Check auth identities
    const authIdentities = await client.query(
      `SELECT ai.id, pi.entity_id, pi.provider 
             FROM auth_identity ai 
             JOIN provider_identity pi ON pi.auth_identity_id = ai.id 
             WHERE pi.entity_id = $1`,
      [email]
    );

    console.log(`📌 Auth identities encontradas: ${authIdentities.rowCount}`);
    if (authIdentities.rowCount > 0) {
      console.log(authIdentities.rows);
    }

    console.log("\n✅ Base de datos limpia para registro");
  } catch (error: any) {
    console.error("❌ Error:", error.message);
  } finally {
    await client.end();
  }
}

checkAuthIdentities();
