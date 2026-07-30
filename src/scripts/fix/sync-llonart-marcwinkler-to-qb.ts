/**
 * sync-llonart-marcwinkler-to-qb.ts
 *
 * Two QB operations:
 *
 * 1. UPDATE Llonart Homes LLC (80001614-1588120935)
 *    Email: stigmawood@yahoo.com → dup_stigmawood@yahoo.com
 *
 * 2. CREATE Marc Winkler / Flash Landscape LLC in QB
 *    Then backfill qb_list_id into Medusa customer cus_01KPRR37YYFKD30XH71QZ0R4HB
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/sync-llonart-marcwinkler-to-qb.ts          # dry-run
 *   yarn ts-node src/scripts/fix/sync-llonart-marcwinkler-to-qb.ts --execute
 */

import "dotenv/config";
import postgres from "postgres";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

const DRY_RUN = !process.argv.includes("--execute");

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY;
const HEADERS = { "x-api-key": API_KEY, "Content-Type": "application/json", "bypass-tunnel-reminder": "true" };

// ─── QB data ─────────────────────────────────────────────────────────────────

const LLONART = {
  ListID: "80001614-1588120935",
  EditSequence: "1776714074",
  Name: "Llonart Homes LLC",
  newEmail: "dup_stigmawood@yahoo.com",
};

const MARC = {
  medusaId: "cus_01KPRR37YYFKD30XH71QZ0R4HB",
  Name: "FLASH LANDSCAPE LLC",
  CompanyName: "FLASH LANDSCAPE LLC",
  FirstName: "MARC",
  LastName: "WINKLER",
  Email: "contac@flashlandscape.com",
  CustomerType: "Independent Contractor",
  PriceLevel: "Wholesale",
  BillAddress: {
    Addr1: "FLASH LANDSCAPE LLC",
    Addr2: "MARC WINKLER",
    City: "-",
    State: "-",
    PostalCode: "-",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function queueOp(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BRIDGE_URL}/api/customers`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bridge error ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.operationId as string;
}

async function pollOp(opId: string, label: string): Promise<any> {
  const MAX = 20;
  for (let i = 1; i <= MAX; i++) {
    await sleep(8000);
    const res = await fetch(`${BRIDGE_URL}/api/sync/status/${opId}`, { headers: HEADERS });
    const json: any = await res.json();
    const op = json?.operation;
    process.stdout.write(`\r  [${label}] poll ${i}/${MAX} — ${op?.status ?? "?"}   `);
    if (op?.status === "completed") { console.log(""); return op.result; }
    if (op?.status === "failed") throw new Error(`QB failed: ${op.error}`);
  }
  throw new Error(`[${label}] timed out`);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const DB_URL = process.env.DATABASE_URL;
  if (!DB_URL) { console.error("❌ DATABASE_URL not set"); process.exit(1); }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  QB sync — ${DRY_RUN ? "DRY RUN" : "⚡ EXECUTE"}`);
  console.log("=".repeat(60) + "\n");

  if (DRY_RUN) {
    console.log("─── WOULD DO ────────────────────────────────────────────────");
    console.log(`\n1. CustomerMod — Llonart Homes LLC`);
    console.log(`   ListID:        ${LLONART.ListID}`);
    console.log(`   EditSequence:  ${LLONART.EditSequence}`);
    console.log(`   Email:         ${LLONART.newEmail}\n`);
    console.log(`2. CustomerAdd — Marc Winkler / Flash Landscape LLC`);
    console.log(`   Name:          ${MARC.Name}`);
    console.log(`   Email:         ${MARC.Email}`);
    console.log(`   PriceLevel:    ${MARC.PriceLevel}`);
    console.log(`   CustomerType:  ${MARC.CustomerType}`);
    console.log(`   → backfill qb_list_id into Medusa ${MARC.medusaId}\n`);
    console.log("─────────────────────────────────────────────────────────────");
    console.log("\nRun with --execute to apply.\n");
    return;
  }

  // ── 1. Update Llonart email in QB ─────────────────────────────────────────
  console.log("1️⃣  Queuing Llonart email update in QB...");
  const llonartOpId = await queueOp({
    action: "mod",
    ListID: LLONART.ListID,
    EditSequence: LLONART.EditSequence,
    Name: LLONART.Name,
    Email: LLONART.newEmail,
  });
  console.log(`   Op queued: ${llonartOpId}`);

  // ── 2. Create Marc Winkler in QB ──────────────────────────────────────────
  console.log("2️⃣  Queuing Marc Winkler creation in QB...");
  const marcOpId = await queueOp({
    action: "add",
    Name: MARC.Name,
    CompanyName: MARC.CompanyName,
    FirstName: MARC.FirstName,
    LastName: MARC.LastName,
    Email: MARC.Email,
    CustomerType: MARC.CustomerType,
    PriceLevel: MARC.PriceLevel,
    BillAddress: MARC.BillAddress,
  });
  console.log(`   Op queued: ${marcOpId}`);

  // ── 3. Poll both ──────────────────────────────────────────────────────────
  console.log("\n⏳ Waiting for QB Web Connector to process...\n");
  const [llonartResult, marcResult] = await Promise.all([
    pollOp(llonartOpId, "Llonart"),
    pollOp(marcOpId, "Marc"),
  ]);

  // ── 4. Extract Marc's new QB ListID ───────────────────────────────────────
  const marcRet =
    marcResult?.QBXML?.QBXMLMsgsRs?.CustomerAddRs?.CustomerRet;

  const marcQbListId: string | undefined = marcRet?.ListID;

  if (!marcQbListId) {
    console.error("❌ Could not extract Marc's QB ListID from response:");
    console.error(JSON.stringify(marcResult, null, 2).substring(0, 500));
    console.log("\n✅ Llonart update completed. Marc may need manual QB ID backfill.");
    return;
  }

  console.log(`\n✅ Llonart email updated in QB → ${LLONART.newEmail}`);
  console.log(`✅ Marc Winkler created in QB — ListID: ${marcQbListId}`);

  // ── 5. Backfill Marc's qb_list_id into Medusa ────────────────────────────
  console.log(`\n3️⃣  Backfilling qb_list_id into Medusa (${MARC.medusaId})...`);
  const sql = postgres(DB_URL, { ssl: "require" });

  await sql`
    UPDATE customer
    SET
      metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{qb_list_id}',
        ${JSON.stringify(marcQbListId)}::jsonb
      ),
      updated_at = NOW()
    WHERE id = ${MARC.medusaId}
  `;

  const [verify] = await sql`
    SELECT metadata->>'qb_list_id' AS qb_list_id FROM customer WHERE id = ${MARC.medusaId}
  `;
  await sql.end();

  console.log(`   ✅ Medusa qb_list_id → ${verify.qb_list_id}\n`);

  console.log("=".repeat(60));
  console.log("  ✅ All done!");
  console.log("=".repeat(60) + "\n");
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
