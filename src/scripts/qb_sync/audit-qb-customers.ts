/**
 * audit-qb-customers.ts
 *
 * 1. Fetches ALL active customers from QuickBooks (via bridge).
 * 2. Saves the raw export to ../../customers_export.json (backend root).
 * 3. Cross-references against Medusa DB and prints three lists:
 *
 *    A) Medusa customers with NO QuickBooks ID (qb_list_id missing from metadata)
 *    B) QB customers NOT in Medusa (no email match AND no qb_list_id match)
 *    C) Medusa customers whose qb_list_id doesn't appear in QB at all
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/qb_sync/audit-qb-customers.ts
 *
 * Flags:
 *   --skip-export   Use existing customers_export.json instead of re-fetching from QB
 *
 * Output:
 *   - customers_export.json  (backend root, updated unless --skip-export)
 *   - qb_audit_report.json   (backend root, always regenerated)
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import postgres from "postgres";

// ─── Config ──────────────────────────────────────────────────────────────────

const BRIDGE_URL =
  process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY =
  process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";
const EXPORT_PATH = path.resolve(__dirname, "../../../customers_export.json");
const REPORT_PATH = path.resolve(__dirname, "../../../qb_audit_report.json");

const INITIAL_WAIT_MS = 2 * 60 * 1000;   // 2 min — QB needs time to process
const POLL_INTERVAL_MS = 2 * 60 * 1000;  // poll every 2 min
const MAX_POLL_ATTEMPTS = 8;              // up to 16 min total

const skipExport = process.argv.includes("--skip-export");

// ─── Types ───────────────────────────────────────────────────────────────────

interface QbCustomer {
  ListID: string;
  Name: string;
  FirstName?: string;
  LastName?: string;
  CompanyName?: string;
  Email?: string;
  IsActive?: boolean | string;
  PriceLevelRef?: { FullName: string };
  CustomerTypeRef?: { FullName: string };
}

interface MedusaCustomer {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  has_account: boolean;
  qb_list_id: string | null;
  created_at: Date;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const DB_URL = process.env.DATABASE_URL;
  if (!DB_URL) {
    console.error("❌ DATABASE_URL not set");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(70));
  console.log("  QB ↔ Medusa Customer Audit");
  console.log("=".repeat(70) + "\n");

  // ── Step 1: Get QB customers ──────────────────────────────────────────────

  let qbCustomers: QbCustomer[] = [];

  if (skipExport && fs.existsSync(EXPORT_PATH)) {
    console.log(`📂 --skip-export: loading ${EXPORT_PATH}`);
    qbCustomers = JSON.parse(fs.readFileSync(EXPORT_PATH, "utf-8"));
    console.log(`   ↳ ${qbCustomers.length} customers loaded from file\n`);
  } else {
    console.log("📡 Requesting customer list from QB bridge...");
    console.log(`   URL: ${BRIDGE_URL}/api/customers\n`);

    const initRes = await fetch(
      `${BRIDGE_URL}/api/customers?MaxReturned=99999&ActiveStatus=All`,
      {
        headers: {
          "x-api-key": API_KEY,
          "bypass-tunnel-reminder": "true",
        },
      }
    );

    if (!initRes.ok) {
      console.error(`❌ Bridge error: ${initRes.status} ${initRes.statusText}`);
      process.exit(1);
    }

    const initJson: any = await initRes.json();
    const operationId = initJson.operationId;
    console.log(`✅ Operation queued — ID: ${operationId}`);
    console.log(
      `⏳ Waiting 2 min before first poll (QB processes ~7,000 records)...\n`
    );
    await sleep(INITIAL_WAIT_MS);

    // Poll until complete
    let attempts = 0;
    let done = false;
    while (!done && attempts < MAX_POLL_ATTEMPTS) {
      attempts++;
      process.stdout.write(
        `⏳ Poll ${attempts}/${MAX_POLL_ATTEMPTS}... `
      );

      const statusRes = await fetch(
        `${BRIDGE_URL}/api/sync/status/${operationId}`,
        {
          headers: {
            "x-api-key": API_KEY,
            "bypass-tunnel-reminder": "true",
          },
        }
      );

      if (!statusRes.ok) {
        console.log(`status ${statusRes.status}, retrying...`);
        await sleep(POLL_INTERVAL_MS);
        continue;
      }

      const statusJson: any = await statusRes.json();
      const op = statusJson?.operation;

      if (op?.status === "completed") {
        const raw =
          op.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet;
        qbCustomers = !raw ? [] : Array.isArray(raw) ? raw : [raw];
        console.log(`✅ ${qbCustomers.length} customers received!`);
        done = true;
      } else if (op?.status === "failed") {
        console.error(`\n❌ QB error: ${op.error}`);
        process.exit(1);
      } else {
        console.log(`status=${op?.status ?? "unknown"}, waiting...`);
        await sleep(POLL_INTERVAL_MS);
      }
    }

    if (!done) {
      console.error("❌ Timed out waiting for QB response. Try --skip-export if you have a recent export.");
      process.exit(1);
    }

    // Save to customers_export.json (same shape as the QB bridge export script)
    fs.writeFileSync(EXPORT_PATH, JSON.stringify(qbCustomers, null, 2));
    console.log(`\n💾 Saved ${qbCustomers.length} customers → ${EXPORT_PATH}\n`);
  }

  // ── Step 2: Load Medusa customers ─────────────────────────────────────────

  console.log("🗄️  Querying Medusa database...");
  const sql = postgres(DB_URL, { ssl: "require" });

  const medusaRows = await sql<MedusaCustomer[]>`
    SELECT
      id,
      email,
      first_name,
      last_name,
      company_name,
      has_account,
      metadata->>'qb_list_id' AS qb_list_id,
      created_at
    FROM customer
    WHERE deleted_at IS NULL
    ORDER BY email ASC
  `;
  await sql.end();

  console.log(`   ↳ ${medusaRows.length} active Medusa customers loaded\n`);

  // ── Step 3: Build lookup maps ──────────────────────────────────────────────

  // Medusa: email (lowercase) → row
  const medusaByEmail = new Map<string, MedusaCustomer>();
  for (const m of medusaRows) {
    medusaByEmail.set(m.email.toLowerCase(), m);
  }

  // Medusa: qb_list_id → row
  const medusaByQbId = new Map<string, MedusaCustomer>();
  for (const m of medusaRows) {
    if (m.qb_list_id) medusaByQbId.set(m.qb_list_id, m);
  }

  // QB: list_id → customer
  const qbByListId = new Map<string, QbCustomer>();
  for (const q of qbCustomers) {
    qbByListId.set(q.ListID, q);
  }

  // QB: email (normalized) → [customers]  (QB can have dupes)
  const qbByEmail = new Map<string, QbCustomer[]>();
  for (const q of qbCustomers) {
    const email = (q.Email ?? "").trim().toLowerCase();
    if (!email) continue;
    if (!qbByEmail.has(email)) qbByEmail.set(email, []);
    qbByEmail.get(email)!.push(q);
  }

  // ── Step 4: Compute the three lists ───────────────────────────────────────

  // A) Medusa customers with NO qb_list_id
  const noQbId = medusaRows.filter((m) => !m.qb_list_id);

  // B) QB customers NOT in Medusa
  //    Criteria: no Medusa customer has this qb_list_id AND no email match
  const missingInMedusa: QbCustomer[] = [];
  for (const q of qbCustomers) {
    const email = (q.Email ?? "").trim().toLowerCase();
    const inMedusaByListId = medusaByQbId.has(q.ListID);
    const inMedusaByEmail = email ? medusaByEmail.has(email) : false;
    if (!inMedusaByListId && !inMedusaByEmail) {
      missingInMedusa.push(q);
    }
  }

  // C) Medusa customers whose qb_list_id doesn't exist in QB anymore
  const orphanInMedusa: MedusaCustomer[] = [];
  for (const m of medusaRows) {
    if (m.qb_list_id && !qbByListId.has(m.qb_list_id)) {
      orphanInMedusa.push(m);
    }
  }

  // ── Step 5: Print report ──────────────────────────────────────────────────

  const sep = "─".repeat(70);

  // ── A: No QB ID ────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  A) MEDUSA CUSTOMERS WITHOUT QuickBooks ID  (${noQbId.length})`);
  console.log("=".repeat(70));
  if (noQbId.length === 0) {
    console.log("  ✅ None — every Medusa customer has a QB ID.");
  } else {
    console.log(
      `  ${"ID".padEnd(30)} ${"EMAIL".padEnd(40)} ${"NAME".padEnd(30)} ${"ACCT"}`
    );
    console.log(`  ${sep}`);
    for (const m of noQbId) {
      const name = [m.first_name, m.last_name].filter(Boolean).join(" ") || "(no name)";
      console.log(
        `  ${m.id.padEnd(30)} ${m.email.padEnd(40)} ${name.padEnd(30)} ${m.has_account ? "yes" : "no"}`
      );
    }
  }

  // ── B: In QB, not in Medusa ────────────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  B) QB CUSTOMERS NOT IN MEDUSA  (${missingInMedusa.length})`);
  console.log("=".repeat(70));
  if (missingInMedusa.length === 0) {
    console.log("  ✅ None — all QB customers are in Medusa.");
  } else {
    console.log(
      `  ${"QB ListID".padEnd(24)} ${"QB Name".padEnd(35)} ${"Email".padEnd(40)} ${"Price Level"}`
    );
    console.log(`  ${sep}`);
    for (const q of missingInMedusa) {
      const pl = q.PriceLevelRef?.FullName ?? "—";
      const email = (q.Email ?? "").substring(0, 38);
      console.log(
        `  ${q.ListID.padEnd(24)} ${q.Name.padEnd(35)} ${email.padEnd(40)} ${pl}`
      );
    }
  }

  // ── C: In Medusa, not in QB ────────────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  C) MEDUSA CUSTOMERS WHOSE QB ID DOESN'T EXIST IN QB  (${orphanInMedusa.length})`);
  console.log("=".repeat(70));
  if (orphanInMedusa.length === 0) {
    console.log("  ✅ None — all linked QB IDs are valid.");
  } else {
    console.log(
      `  ${"Medusa ID".padEnd(30)} ${"Email".padEnd(40)} ${"QB List ID (stale)"}`
    );
    console.log(`  ${sep}`);
    for (const m of orphanInMedusa) {
      console.log(
        `  ${m.id.padEnd(30)} ${m.email.padEnd(40)} ${m.qb_list_id}`
      );
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log(`  QB customers fetched:               ${qbCustomers.length}`);
  console.log(`  Medusa customers (active):          ${medusaRows.length}`);
  console.log(`  A) No QB ID in Medusa:              ${noQbId.length}`);
  console.log(`  B) In QB, missing from Medusa:      ${missingInMedusa.length}`);
  console.log(`  C) Medusa QB ID not found in QB:    ${orphanInMedusa.length}`);
  console.log("=".repeat(70) + "\n");

  // ── Save JSON report ─────────────────────────────────────────────────────
  const report = {
    generated_at: new Date().toISOString(),
    stats: {
      qb_total: qbCustomers.length,
      medusa_total: medusaRows.length,
      no_qb_id: noQbId.length,
      missing_in_medusa: missingInMedusa.length,
      orphan_in_medusa: orphanInMedusa.length,
    },
    a_no_qb_id: noQbId.map((m) => ({
      medusa_id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(" "),
      has_account: m.has_account,
      created_at: m.created_at,
    })),
    b_missing_in_medusa: missingInMedusa.map((q) => ({
      qb_list_id: q.ListID,
      name: q.Name,
      first_name: q.FirstName ?? "",
      last_name: q.LastName ?? "",
      company: q.CompanyName ?? "",
      email: q.Email ?? "",
      price_level: q.PriceLevelRef?.FullName ?? "",
      customer_type: q.CustomerTypeRef?.FullName ?? "",
    })),
    c_orphan_in_medusa: orphanInMedusa.map((m) => ({
      medusa_id: m.id,
      email: m.email,
      name: [m.first_name, m.last_name].filter(Boolean).join(" "),
      stale_qb_list_id: m.qb_list_id,
    })),
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`📄 Full report saved → ${REPORT_PATH}\n`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});
