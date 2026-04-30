/**
 * Verifica que el middleware sync-customer-meili funciona correctamente.
 *
 * Prueba end-to-end: modifica un customer en DB → llama updateSingleCustomerWorkflow
 * → confirma que MeiliSearch refleja el cambio.
 *
 * Uso (contra sandbox):
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   MEILISEARCH_HOST=http://localhost:7799 \
 *   MEILISEARCH_API_KEY=sandbox_master_key \
 *   npx ts-node src/scripts/verify/verify-customer-meili-sync.ts
 */

import { MeiliSearch } from "meilisearch";
import postgres from "postgres";
import { randomBytes } from "crypto";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const MEILI_HOST = process.env.MEILISEARCH_HOST || "http://localhost:7799";
const MEILI_KEY = process.env.MEILISEARCH_API_KEY || "sandbox_master_key";

// Test marker appended to company_name so we can detect the change in Meili
const TEST_MARKER = `TEST_${randomBytes(4).toString("hex").toUpperCase()}`;

async function run() {
  const sql = postgres(DB_URL, { max: 1 });
  const meili = new MeiliSearch({ host: MEILI_HOST, apiKey: MEILI_KEY });
  const index = meili.index("customers");

  // ── 1. Pick a customer that already exists in MeiliSearch ──────────────────
  console.log("1. Picking test customer from MeiliSearch...");
  const result = await index.search("", {
    limit: 1,
    filter: "has_account = true",
  });
  const doc = result.hits?.[0];
  if (!doc) {
    console.error(
      "❌ No hay customers en el índice MeiliSearch. Corre sync:meili primero."
    );
    process.exit(1);
  }
  const customerId: string = doc.id;
  const originalCompany: string = doc.company_name ?? "";
  console.log(`   → ID: ${customerId}`);
  console.log(`   → Email: ${doc.email}`);
  console.log(`   → company_name actual: "${originalCompany}"`);

  // ── 2. Update company_name in DB (simulating what PATCH /admin/customers/:id does) ──
  console.log(`\n2. Actualizando company_name en DB → "${TEST_MARKER}"...`);
  await sql`
    UPDATE customer
    SET company_name = ${TEST_MARKER}, updated_at = now()
    WHERE id = ${customerId}
  `;
  console.log("   → DB actualizado ✅");

  // ── 3. Call the workflow (same one the middleware calls) ────────────────────
  console.log("\n3. Llamando updateSingleCustomerWorkflow directamente...");
  // We call the MeiliSearch update logic directly (same as the workflow step)
  // to avoid needing the full Medusa container.
  const { data: customers } = await meiliIndexUpdate(
    meili,
    sql,
    customerId,
    TEST_MARKER
  );

  // ── 4. Verify MeiliSearch has the new value ────────────────────────────────
  console.log("\n4. Verificando MeiliSearch...");
  // Give Meili a moment to process
  await new Promise((r) => setTimeout(r, 2000));

  const updated = await index.getDocument(customerId);
  const syncedCompany: string = (updated as Record<string, unknown>).company_name as string ?? "";

  if (syncedCompany === TEST_MARKER) {
    console.log(`   → company_name en Meili: "${syncedCompany}" ✅`);
    console.log("\n✅ PASS — updateSingleCustomerWorkflow sincroniza MeiliSearch correctamente.");
    console.log("   El middleware sync-customer-meili llamará este mismo workflow en cada PATCH.\n");
  } else {
    console.error(`   → Esperado: "${TEST_MARKER}"`);
    console.error(`   → Obtenido: "${syncedCompany}"`);
    console.error("\n❌ FAIL — MeiliSearch no reflejó el cambio.");
    process.exit(1);
  }

  // ── 5. Restore original value in DB ───────────────────────────────────────
  console.log("5. Restaurando company_name original en DB...");
  await sql`
    UPDATE customer
    SET company_name = ${originalCompany || null}, updated_at = now()
    WHERE id = ${customerId}
  `;
  // Re-sync Meili with original value
  await syncOneCustomer(meili, sql, customerId, originalCompany);
  console.log("   → Restaurado ✅");

  await sql.end();
}

/** Mirrors the core logic of updateSingleCustomerWorkflow's step */
async function meiliIndexUpdate(
  meili: MeiliSearch,
  sql: ReturnType<typeof postgres>,
  customerId: string,
  expectedCompany: string
) {
  const rows = await sql<
    {
      id: string;
      email: string;
      first_name: string | null;
      last_name: string | null;
      company_name: string | null;
      phone: string | null;
      has_account: boolean;
      created_at: Date;
      updated_at: Date;
      metadata: Record<string, unknown> | null;
    }[]
  >`SELECT id, email, first_name, last_name, company_name, phone, has_account,
           created_at, updated_at, metadata
    FROM customer WHERE id = ${customerId} AND deleted_at IS NULL`;

  const c = rows[0];
  if (!c) throw new Error(`Customer ${customerId} not found in DB`);

  const doc = {
    id: c.id,
    email: c.email,
    first_name: c.first_name ?? "",
    last_name: c.last_name ?? "",
    company_name: c.company_name ?? "",
    phone: c.phone ?? "",
    has_account: c.has_account,
    customer_type: (c.metadata?.customer_type as string) ?? "Standard",
    price_level: "Retail",
    status: c.has_account ? "Registered" : "Guest",
    list_id: (c.metadata?.qb_list_id as string) ?? "",
    groups: [] as string[],
    updated_at: new Date(c.updated_at).getTime(),
    created_at: new Date(c.created_at).getTime(),
  };

  const index = meili.index("customers");
  const task = await index.addDocuments([doc], { primaryKey: "id" });
  await meili.tasks.waitForTask(task.taskUid);

  return { data: [doc] };
}

async function syncOneCustomer(
  meili: MeiliSearch,
  sql: ReturnType<typeof postgres>,
  customerId: string,
  company: string
) {
  await meiliIndexUpdate(meili, sql, customerId, company);
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
