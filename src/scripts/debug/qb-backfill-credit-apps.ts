/**
 * Fase "aplicaciones de Vendor Credits" del backfill, sobre el caché QB ya
 * descargado (sin bridge). Dry-run por default; `--apply` sólo sandbox.
 *   DATABASE_URL=… tsx src/scripts/debug/qb-backfill-credit-apps.ts [--apply] [--cache-dir DIR]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { normalizeBills, normalizeVendorCredits } from "../../lib/qb-backfill/normalize";
import { applyCreditApplications, loadCreditApplicationIndexes, planCreditApplications } from "../../lib/qb-backfill/apply-credit-links";
import type { QbBill, QbVendorCredit } from "../../lib/qb-backfill/types";

async function main(): Promise<void> {
  const APPLY = process.argv.includes("--apply");
  const dirArg = process.argv.indexOf("--cache-dir");
  const DIR = dirArg > 0 ? process.argv[dirArg + 1] : ".qb-docs-cache";
  const url = process.env.DATABASE_URL ?? "";
  if (APPLY && (process.env.ECOPOWERTECH_ENV !== "sandbox" || !/localhost:5499/.test(url))) {
    throw new Error("--apply exige ECOPOWERTECH_ENV=sandbox y DATABASE_URL del sandbox");
  }
  const bills = new Map<string, QbBill>();
  const credits = new Map<string, QbVendorCredit>();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Record<string, unknown>;
    if (f.startsWith("bill_") || f.startsWith("deadopt_")) for (const b of normalizeBills(raw)) bills.set(b.txn_id, b);
    if (f.startsWith("credit_")) for (const c of normalizeVendorCredits(raw)) credits.set(c.txn_id, c);
  }
  console.log(`caché: bills ${bills.size} · créditos ${credits.size}`);
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const idx = await loadCreditApplicationIndexes(client);
    const plan = planCreditApplications([...bills.values()], [...credits.values()], idx.creditIndex, idx.billIndex, idx.existingPairs);
    const byReason = new Map<string, number>();
    for (const sk of plan.skipped) byReason.set(sk.reason, (byReason.get(sk.reason) ?? 0) + 1);
    const total = plan.rows.reduce((a, r) => a + r.amount_cents, 0);
    console.log(`a aplicar: ${plan.rows.length} pares ($${(total / 100).toFixed(2)}) · créditos ${new Set(plan.rows.map((r) => r.credit_id)).size} · bills ${new Set(plan.rows.map((r) => r.vendor_bill_id)).size}`);
    console.log(`saltadas: ${[...byReason].map(([k, v]) => `${k}=${v}`).join(" ") || "0"}`);
    for (const sk of plan.skipped.filter((x) => x.reason !== "already")) console.log(`  ${sk.reason}: crédito ${sk.credit_txn_id} → bill ${sk.bill_txn_id}`);
    if (APPLY) console.log("aplicado:", await applyCreditApplications(client, plan, "qbbf-20260911-2026"));
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
