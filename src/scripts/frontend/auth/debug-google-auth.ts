export default async function debugGoogleAuth({
  container,
}: {
  container: any;
}) {
  const query = container.resolve("query");

  console.log("Searching for customer a.vargas@ecopowertech.com...");
  const { data: customers } = await query.graph({
    entity: "customer",
    filters: { email: "a.vargas@ecopowertech.com" },
    fields: ["id", "email", "has_account"],
  });

  const customerId = customers?.[0]?.id;
  console.log("Customer found:", customers?.[0]);

  if (!customerId) return;

  const postgres = await import("postgres");
  const sql = postgres.default(process.env.DATABASE_URL!);

  console.log("Querying auth_identity linked to customer_id:", customerId);
  const authIdentities = await sql`
    SELECT *
    FROM auth_identity 
    WHERE app_metadata->>'customer_id' = ${customerId}
  `;
  console.log("Auth Identities for customer:");
  console.log(authIdentities);

  if (authIdentities.length > 0) {
    console.log("Fetching provider_identities for these auth identities...");
    for (const ai of authIdentities) {
      const pis =
        await sql`SELECT * FROM provider_identity WHERE auth_identity_id = ${ai.id}`;
      console.log(`Provider identities for AI ${ai.id}:`, pis);
    }
  }

  console.log(
    "\nSearching for any 'google' provider_identity holding email a.vargas..."
  );

  const allGoogleAuths = await sql`
    SELECT *
    FROM provider_identity 
    WHERE provider = 'google'
  `;

  let found = 0;
  for (const row of allGoogleAuths) {
    const authDataStr = JSON.stringify(row.auth_identity_data || {});
    const userDataStr = JSON.stringify(row.user_metadata || {});
    if (authDataStr.includes("a.vargas") || userDataStr.includes("a.vargas")) {
      console.log("\nProviderIdentity with email match:", row);
      const ai =
        await sql`SELECT * FROM auth_identity WHERE id = ${row.auth_identity_id}`;
      console.log("Corresponding AuthIdentity:", ai[0]);
      found++;
    }
  }
  console.log(
    `\nFound ${found} Google provider identities containing 'a.vargas'.`
  );

  await sql.end();
}
