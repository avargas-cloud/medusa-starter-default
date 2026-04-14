import { getSql } from "../lib/db";
import "dotenv/config";

async function testTransaction() {
  const sql = getSql();

  console.log("🧪 TEST 1: WITHOUT sql.begin() - Direct INSERTs");

  try {
    const testAuthId = "authid_test_direct_" + Date.now();

    console.log("  1. Inserting auth_identity...");
    await sql`
            INSERT INTO auth_identity (id, app_metadata)
            VALUES (${testAuthId}, ${sql.json({ customer_id: "test123" })})
        `;
    console.log("  ✅ Auth identity inserted");

    console.log("  2. Querying auth_identity...");
    const [found] = await sql`
            SELECT id FROM auth_identity WHERE id = ${testAuthId}
        `;
    console.log("  Result:", found ? "✅ FOUND" : "❌ NOT FOUND");

    console.log("  3. Cleaning up...");
    await sql`DELETE FROM auth_identity WHERE id = ${testAuthId}`;
    console.log("  ✅ Cleaned up\n");
  } catch (err) {
    console.error("  ❌ Error:", err);
  }

  console.log("🧪 TEST 2: WITH sql.begin() - Transaction");

  try {
    const testAuthId = "authid_test_txn_" + Date.now();

    console.log("  1. Starting transaction...");
    const result = await sql.begin(async (txn) => {
      console.log("  2. Inside transaction");

      const metadata = JSON.stringify({ customer_id: "test123" });
      // @ts-ignore - TransactionSql type issue with postgres.js
      await txn`
                INSERT INTO auth_identity (id, app_metadata)
                VALUES (${testAuthId}, ${metadata}::jsonb)
            `;
      console.log("  ✅ Auth identity inserted inside transaction");

      return testAuthId;
    });

    console.log("  3. Transaction completed, returned:", result);

    console.log("  4. Querying auth_identity OUTSIDE transaction...");
    const [found] = await sql`
            SELECT id FROM auth_identity WHERE id = ${testAuthId}
        `;
    console.log(
      "  Result:",
      found
        ? "✅ FOUND - Transaction committed!"
        : "❌ NOT FOUND - Transaction rolled back!"
    );

    if (found) {
      console.log("  5. Cleaning up...");
      await sql`DELETE FROM auth_identity WHERE id = ${testAuthId}`;
    }
  } catch (err) {
    console.error("  ❌ Error:", err);
  }

  process.exit(0);
}

testTransaction();
