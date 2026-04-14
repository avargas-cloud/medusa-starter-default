import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

  const customers =
    await sql`SELECT id, email FROM customer WHERE email = 'a.vargas@ecopowertech.com' LIMIT 1`;
  console.log("Customer:", JSON.stringify(customers[0]));

  const customerId = customers[0]?.id;
  const identities =
    await sql`SELECT id, app_metadata FROM auth_identity WHERE app_metadata->>'customer_id' = ${customerId}`;
  console.log("Auth identities:", JSON.stringify(identities));

  for (const id of identities) {
    const providers =
      await sql`SELECT id, entity_id, provider, auth_identity_id FROM provider_identity WHERE auth_identity_id = ${id.id}`;
    console.log("Providers for", id.id, ":", JSON.stringify(providers));
  }

  const allProviders =
    await sql`SELECT id, entity_id, provider, auth_identity_id FROM provider_identity WHERE entity_id = 'a.vargas@ecopowertech.com'`;
  console.log("All providers by email:", JSON.stringify(allProviders));

  await sql.end();
}

main().catch(console.error);
