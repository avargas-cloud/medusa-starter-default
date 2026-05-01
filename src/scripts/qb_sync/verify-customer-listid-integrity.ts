/**
 * verify-customer-listid-integrity.ts
 *
 * For every Medusa customer that has metadata.qb_list_id, find that ListID in
 * the latest QB bulk export (customers_export.json) and verify the QB record
 * still represents the same customer.
 *
 * Match on 3 fields: email, person name (first+last), company name.
 * - 3/3 -> OK
 * - 2/3 -> OK with minor drift (one field changed, same customer)
 * - 1/3 -> SUSPECT (likely different customer)
 * - 0/3 -> CRITICAL (definitely different customer — wrong-account billing risk)
 *
 * Reads:  customers_export.json   (refresh first via audit-qb-customers.ts)
 * Writes: qb_listid_integrity_report.json
 */

import "dotenv/config";
import * as path from "path";
import * as fs from "fs";
import { Client } from "pg";

const EXPORT_PATH = path.resolve(__dirname, "../../../customers_export.json");
const REPORT_PATH = path.resolve(__dirname, "../../../qb_listid_integrity_report.json");

interface QbCustomer {
  ListID: string;
  Name?: string;
  FullName?: string;
  IsActive?: string;
  CompanyName?: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  EditSequence?: string;
  TimeModified?: string;
}

interface MedusaCustomer {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  qb_list_id: string;
}

const norm = (s: unknown): string =>
  (s ?? "")
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s.,]+/g, " ")
    .replace(/\b(llc|inc|corp|co|ltd|company|corporation)\b\.?/g, "")
    .replace(/\s+/g, " ")
    .trim();

function loadExport(): Map<string, QbCustomer> {
  const raw = JSON.parse(fs.readFileSync(EXPORT_PATH, "utf-8"));
  const list: QbCustomer[] = Array.isArray(raw) ? raw : raw.customers || [];
  const map = new Map<string, QbCustomer>();
  for (const c of list) if (c.ListID) map.set(c.ListID, c);
  return map;
}

async function loadMedusa(): Promise<MedusaCustomer[]> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const sql = `
    SELECT
      id,
      email,
      first_name,
      last_name,
      company_name,
      metadata->>'qb_list_id' AS qb_list_id
    FROM customer
    WHERE metadata->>'qb_list_id' IS NOT NULL
      AND metadata->>'qb_list_id' <> ''
      AND deleted_at IS NULL
  `;
  const res = await client.query<MedusaCustomer>(sql);
  await client.end();
  return res.rows;
}

interface MatchResult {
  medusa_id: string;
  qb_list_id: string;
  found_in_qb: boolean;
  qb_is_active?: string;
  email_match: boolean | null;
  name_match: boolean | null;
  company_match: boolean | null;
  score: number;
  verdict: "OK_EXACT" | "OK_DRIFT" | "SUSPECT" | "CRITICAL_MISMATCH" | "NOT_IN_EXPORT";
  medusa_email: string | null;
  medusa_name: string | null;
  medusa_company: string | null;
  qb_email: string | null;
  qb_name: string | null;
  qb_company: string | null;
}

function compare(m: MedusaCustomer, q: QbCustomer | undefined): MatchResult {
  const medusaName = norm([m.first_name, m.last_name].filter(Boolean).join(" "));
  const medusaEmail = norm(m.email);
  const medusaCompany = norm(m.company_name);

  if (!q) {
    return {
      medusa_id: m.id,
      qb_list_id: m.qb_list_id,
      found_in_qb: false,
      email_match: null,
      name_match: null,
      company_match: null,
      score: 0,
      verdict: "NOT_IN_EXPORT",
      medusa_email: m.email,
      medusa_name: [m.first_name, m.last_name].filter(Boolean).join(" ") || null,
      medusa_company: m.company_name,
      qb_email: null,
      qb_name: null,
      qb_company: null,
    };
  }

  const qbName = norm([q.FirstName, q.LastName].filter(Boolean).join(" ") || q.FullName || q.Name || "");
  const qbEmail = norm(q.Email);
  const qbCompany = norm(q.CompanyName);

  const emailComparable = !!medusaEmail && !!qbEmail;
  const nameComparable = !!medusaName && !!qbName;
  const companyComparable = !!medusaCompany && !!qbCompany;

  const email_match = emailComparable ? medusaEmail === qbEmail : null;
  const name_match = nameComparable ? medusaName === qbName : null;
  const company_match = companyComparable ? medusaCompany === qbCompany : null;

  const score =
    (email_match === true ? 1 : 0) +
    (name_match === true ? 1 : 0) +
    (company_match === true ? 1 : 0);

  const comparable =
    (emailComparable ? 1 : 0) + (nameComparable ? 1 : 0) + (companyComparable ? 1 : 0);

  let verdict: MatchResult["verdict"];
  if (score >= 3) verdict = "OK_EXACT";
  else if (score >= 2) verdict = "OK_DRIFT";
  else if (score === 1) verdict = comparable >= 2 ? "SUSPECT" : "OK_DRIFT";
  else verdict = "CRITICAL_MISMATCH";

  return {
    medusa_id: m.id,
    qb_list_id: m.qb_list_id,
    found_in_qb: true,
    qb_is_active: q.IsActive,
    email_match,
    name_match,
    company_match,
    score,
    verdict,
    medusa_email: m.email,
    medusa_name: [m.first_name, m.last_name].filter(Boolean).join(" ") || null,
    medusa_company: m.company_name,
    qb_email: q.Email ?? null,
    qb_name: [q.FirstName, q.LastName].filter(Boolean).join(" ") || q.FullName || q.Name || null,
    qb_company: q.CompanyName ?? null,
  };
}

async function main(): Promise<void> {
  console.log("======================================================================");
  console.log("  QB ListID Integrity Check (3-field match: email + name + company)");
  console.log("======================================================================\n");

  if (!fs.existsSync(EXPORT_PATH)) {
    console.error("❌ customers_export.json not found. Run audit-qb-customers.ts first.");
    process.exit(1);
  }

  const exportStat = fs.statSync(EXPORT_PATH);
  console.log(`📂 QB export:    ${EXPORT_PATH}`);
  console.log(`   modified:     ${exportStat.mtime.toISOString()}\n`);

  const qbMap = loadExport();
  console.log(`📊 QB customers in export: ${qbMap.size}`);

  const medusaCustomers = await loadMedusa();
  console.log(`📊 Medusa customers w/ qb_list_id: ${medusaCustomers.length}\n`);

  const results: MatchResult[] = medusaCustomers.map((m) =>
    compare(m, qbMap.get(m.qb_list_id))
  );

  const buckets = {
    OK_EXACT: results.filter((r) => r.verdict === "OK_EXACT"),
    OK_DRIFT: results.filter((r) => r.verdict === "OK_DRIFT"),
    SUSPECT: results.filter((r) => r.verdict === "SUSPECT"),
    CRITICAL_MISMATCH: results.filter((r) => r.verdict === "CRITICAL_MISMATCH"),
    NOT_IN_EXPORT: results.filter((r) => r.verdict === "NOT_IN_EXPORT"),
  };

  console.log("======================================================================");
  console.log("  SUMMARY");
  console.log("======================================================================");
  console.log(`  ✅ OK exact (3/3):              ${buckets.OK_EXACT.length}`);
  console.log(`  ✅ OK with drift (2/3):         ${buckets.OK_DRIFT.length}`);
  console.log(`  ⚠️  SUSPECT (1/3):              ${buckets.SUSPECT.length}`);
  console.log(`  🚨 CRITICAL mismatch (0/3):     ${buckets.CRITICAL_MISMATCH.length}`);
  console.log(`  ❌ ListID not in QB export:     ${buckets.NOT_IN_EXPORT.length}`);
  console.log("======================================================================\n");

  for (const v of ["CRITICAL_MISMATCH", "SUSPECT", "NOT_IN_EXPORT"] as const) {
    if (buckets[v].length === 0) continue;
    console.log(`\n>> ${v} (${buckets[v].length})`);
    console.log(
      "   medusa_id".padEnd(30) +
        "qb_list_id".padEnd(28) +
        "medusa".padEnd(50) +
        "qb"
    );
    console.log("   " + "─".repeat(150));
    for (const r of buckets[v]) {
      const mInfo = `${r.medusa_email || "—"} | ${r.medusa_name || "—"} | ${r.medusa_company || "—"}`.slice(0, 48);
      const qInfo = r.found_in_qb
        ? `${r.qb_email || "—"} | ${r.qb_name || "—"} | ${r.qb_company || "—"}`
        : "(not found in QB export)";
      console.log(
        "   " +
          (r.medusa_id || "").slice(0, 28).padEnd(30) +
          (r.qb_list_id || "").padEnd(28) +
          mInfo.padEnd(50) +
          qInfo
      );
    }
  }

  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        export_modified_at: exportStat.mtime.toISOString(),
        stats: {
          medusa_with_qb_id: medusaCustomers.length,
          qb_total: qbMap.size,
          ok_exact: buckets.OK_EXACT.length,
          ok_drift: buckets.OK_DRIFT.length,
          suspect: buckets.SUSPECT.length,
          critical: buckets.CRITICAL_MISMATCH.length,
          not_in_export: buckets.NOT_IN_EXPORT.length,
        },
        critical_mismatch: buckets.CRITICAL_MISMATCH,
        suspect: buckets.SUSPECT,
        not_in_export: buckets.NOT_IN_EXPORT,
        ok_drift: buckets.OK_DRIFT,
      },
      null,
      2
    )
  );

  console.log(`\n📄 Full report saved -> ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
