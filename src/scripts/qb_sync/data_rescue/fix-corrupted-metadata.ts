/// <reference types="node" />
import "dotenv/config";
import postgres from "postgres";

/**
 * EMERGENCY FIX: Repair corrupted customer metadata
 * Metadata is corrupted with mixed JSON + extra fields
 */

async function fixCorruptedMetadata() {
  const sql = postgres(process.env.DATABASE_URL!);
  const email = "a.vargas@ecopowertech.com";

  console.log(`\n🔧 FIXING CORRUPTED METADATA: ${email}\n`);

  try {
    // Get customer
    const [customer] = await sql`
            SELECT id, email, metadata FROM customer WHERE email = ${email}
        `;

    if (!customer) {
      console.log("❌ Customer not found");
      process.exit(1);
    }

    console.log("✅ Customer found:", customer.id);
    console.log("📦 Current metadata:");
    console.log(JSON.stringify(customer.metadata, null, 2));

    // Set clean metadata - just keep legacy_customer flag
    const cleanMetadata = {
      legacy_customer: true,
      activated_at: "2026-02-03T16:53:27.130Z",
    };

    console.log("\n🔄 Setting clean metadata...");

    await sql`
            UPDATE customer
            SET metadata = ${sql.json(cleanMetadata)}
            WHERE id = ${customer.id}
        `;

    console.log("✅ Metadata cleaned!");

    // Verify
    const [verify] = await sql`
            SELECT id, email, metadata FROM customer WHERE id = ${customer.id}
        `;

    console.log("\n📊 NEW METADATA:");
    console.log(JSON.stringify(verify.metadata, null, 2));

    console.log("\n✅✅✅ SUCCESS!");
  } catch (error) {
    console.error("\n❌ Error:", error);
  } finally {
    await sql.end();
    process.exit(0);
  }
}

fixCorruptedMetadata();
