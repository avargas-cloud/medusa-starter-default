import postgres from "postgres";
import { loadEnv } from "@medusajs/utils";
import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";

loadEnv("development", process.cwd());
const sql = postgres(process.env.DATABASE_URL!);
const scryptAsync = promisify(scrypt);

async function testActivationSQL() {
  const email = "a.vargas@ecopowertech.com";
  const password = "FinalFinalTest123!";

  try {
    // Get customer
    const [customer] = await sql`SELECT * FROM customer WHERE email = ${email}`;
    console.log("✅ Customer found:", customer.id);

    // Generate password hash
    const salt = randomBytes(16);
    const hashedPassword = (await scryptAsync(password, salt, 64)) as Buffer;
    const passwordHash = Buffer.concat([
      Buffer.from("scrypt"),
      Buffer.from([0, 15, 0, 0, 0, 8, 0, 0, 0, 1]),
      salt,
      hashedPassword,
    ]).toString("base64");

    console.log("✅ Password hash generated");

    // Create auth_identity
    console.log("🔐 Creating auth_identity...");
    const [authIdentity] = await sql`
            INSERT INTO auth_identity (
                id,
                app_metadata
            )
            VALUES (
                'authid_' || substr(md5(random()::text), 0, 25),
                ${JSON.stringify({ customer_id: customer.id })}::jsonb
            )
            RETURNING id
        `;

    console.log("✅ Auth identity created:", authIdentity.id);

    // Create provider_identity
    console.log("🔐 Creating provider_identity...");
    await sql`
            INSERT INTO provider_identity (
                id,
                entity_id,
                provider,
                auth_identity_id,
                provider_metadata
            )
            VALUES (
                substr(md5(random()::text), 0, 25),
                ${email},
                'emailpass',
                ${authIdentity.id},
                ${JSON.stringify({ password: passwordHash })}::jsonb
            )
        `;

    console.log("✅ Provider identity created");

    // Update customer
    console.log("🔄 Updating customer...");
    await sql`
            UPDATE customer
            SET has_account = true
            WHERE id = ${customer.id}
        `;

    console.log("✅ Customer updated - has_account = true");
    console.log("\n🎉 ACTIVATION SIMULATION SUCCESSFUL!");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await sql.end();
  }
}

testActivationSQL();
