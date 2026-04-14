/**
 * Script to completely delete a test customer (Auth Identity + Customer Profile)
 * Usage: email=test@example.com npx -y tsx src/scripts/delete-test-customer-simple.ts
 */

import { Client } from "pg";
import dotenv from "dotenv";

dotenv.config();

async function deleteCustomer() {
  const email = process.env.email;

  if (!email) {
    console.error("❌ Error: Email required");
    console.log(
      "Usage: email=test@example.com npx -y tsx src/scripts/delete-test-customer-simple.ts"
    );
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    await client.connect();
    console.log(`🔍 Looking for customer: ${email}\n`);

    // Get customer ID
    const customerResult = await client.query(
      `SELECT id FROM customer WHERE email = $1`,
      [email]
    );

    if (customerResult.rows.length === 0) {
      console.log("⚠️  Customer not found (may not have existed)");
      return;
    }

    const customerId = customerResult.rows[0].id;
    console.log(`📌 Customer ID: ${customerId}`);

    // Delete provider identities first (auth identity)
    const deleteIdentities = await client.query(
      `DELETE FROM provider_identity 
             WHERE auth_identity_id IN (
                 SELECT id FROM auth_identity WHERE app_metadata->>'email' = $1
             ) OR user_metadata->>'email' = $1
             RETURNING id`,
      [email]
    );
    console.log(`✅ Provider identities deleted: ${deleteIdentities.rowCount}`);

    // Delete auth identity
    const deleteAuthIdentities = await client.query(
      `DELETE FROM auth_identity 
             WHERE app_metadata->>'email' = $1 
             RETURNING id`,
      [email]
    );
    console.log(`✅ Auth identities deleted: ${deleteAuthIdentities.rowCount}`);

    // Delete customer
    const deleteCustomer = await client.query(
      `DELETE FROM customer WHERE id = $1 RETURNING id`,
      [customerId]
    );
    console.log(`✅ Customer deleted: ${deleteCustomer.rowCount}`);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`✨ ${email} can now be reused for registration`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    throw error;
  } finally {
    await client.end();
  }
}

deleteCustomer();
