import postgres from "postgres";
import { loadEnv } from "@medusajs/utils";

loadEnv("development", process.cwd());
const sql = postgres(process.env.DATABASE_URL!);

async function getActivationToken() {
  const email = "a.vargas@ecopowertech.com";

  const [customer] = await sql`
        SELECT id, email, metadata
        FROM customer
        WHERE email = ${email}
    `;

  if (!customer) {
    console.log("❌ Customer not found");
    await sql.end();
    return;
  }

  console.log("✅ Customer found:", customer.id);
  console.log("📧 Email:", customer.email);

  const metadata = customer.metadata as any;
  const token = metadata?.activation_token;

  if (!token) {
    console.log("❌ No activation token found");
    console.log("Metadata:", metadata);
  } else {
    console.log("✅ Activation token:", token);
    console.log("\n📝 Test activation with:");
    console.log(`curl -X POST http://localhost:9000/store/auth/activate \\
  -H "Content-Type: application/json" \\
  -H "x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3" \\
  -d '{"token": "${token}"}'`);
  }

  await sql.end();
}

getActivationToken();
