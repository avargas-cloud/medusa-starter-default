/**
 * src/scripts/verify/verify-qb-invoice-gate.ts
 *
 * READ-ONLY verification for the Fase 3 Order Pipeline Gate.
 * Standalone Node script — does NOT bootstrap Medusa (avoids interference from
 * unrelated module load errors). Uses pg directly from DATABASE_URL.
 *
 * This script does NOT create, update, or delete any row. It reads the state
 * of the gate + poller + endpoint modules and reports whether the gate is
 * healthy:
 *
 *  1. Imports the gate + poller + endpoint files (proves they compile)
 *  2. Counts pos_invoice rows currently held by the gate
 *  3. Simulates the poller readiness check on each waiting invoice
 *  4. Spot-checks recent pos_invoice_items for variants missing quickbooks_id
 *  5. Confirms pos_invoice.metadata and product_variant.metadata columns exist
 *
 * Run:
 *   cd backend
 *   node --import tsx ./src/scripts/verify/verify-qb-invoice-gate.ts
 *     or
 *   DATABASE_URL="…" npx tsx ./src/scripts/verify/verify-qb-invoice-gate.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";

const PREFIX = "[verify-qb-invoice-gate]";
const log = (...args: any[]) => console.log(PREFIX, ...args);
const warn = (...args: any[]) => console.warn(PREFIX, ...args);
const err = (...args: any[]) => console.error(PREFIX, ...args);

const loadDatabaseUrl = (): string => {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const envPath = join(process.cwd(), ".env");
    const content = readFileSync(envPath, "utf8");
    const match = content.match(/^DATABASE_URL=(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  throw new Error("DATABASE_URL not set and .env not found");
};

async function main() {
  let failures = 0;
  log("═══════════════════════════════════════════════════════════════");
  log("Fase 3 — QB Invoice Gate verification (READ-ONLY)");
  log("═══════════════════════════════════════════════════════════════");

  // ── 1. Module import sanity ──────────────────────────────────────────
  log("");
  log("[1/5] Loading gate + poller + endpoint modules…");
  try {
    const pollerMod: any = await import("../../jobs/qb-invoice-waiting-gate");
    if (typeof pollerMod.default !== "function") {
      err("  ✗ qb-invoice-waiting-gate has no default export function");
      failures++;
    } else {
      log("  ✓ jobs/qb-invoice-waiting-gate.ts exports default fn");
      log("    schedule:", pollerMod.config?.schedule ?? "<missing>");
    }
  } catch (e: any) {
    err("  ✗ Failed to import qb-invoice-waiting-gate:", e.message);
    failures++;
  }

  try {
    const listMod: any = await import(
      "../../api/admin/qb-catalog/waiting-invoices/route"
    );
    if (typeof listMod.GET !== "function") {
      err("  ✗ waiting-invoices/route has no GET export");
      failures++;
    } else {
      log("  ✓ GET /admin/qb-catalog/waiting-invoices exports GET");
    }
  } catch (e: any) {
    err("  ✗ Failed to import waiting-invoices/route:", e.message);
    failures++;
  }

  try {
    const markMod: any = await import(
      "../../api/admin/qb-catalog/waiting-invoices/[id]/mark-manual/route"
    );
    if (typeof markMod.POST !== "function") {
      err("  ✗ mark-manual/route has no POST export");
      failures++;
    } else {
      log("  ✓ POST mark-manual/route exports POST");
    }
  } catch (e: any) {
    err("  ✗ Failed to import mark-manual/route:", e.message);
    failures++;
  }

  // ── DB-backed checks ─────────────────────────────────────────────────
  const client = new Client({ connectionString: loadDatabaseUrl() });
  try {
    await client.connect();
    log("");
    log("  ℹ Connected to Postgres");
  } catch (e: any) {
    err("  ✗ Could not connect to Postgres:", e.message);
    err("    Skipping DB-backed checks. Aborting.");
    process.exitCode = 1;
    return;
  }

  // ── 2. Count currently waiting invoices ──────────────────────────────
  log("");
  log("[2/5] Counting pos_invoice rows with waiting_qb_items=true…");
  let waitingInvoices: any[] = [];
  try {
    const res = await client.query(
      `SELECT id, invoice_number, order_id, total, created_at, metadata
         FROM pos_invoice
        WHERE metadata ->> 'waiting_qb_items' = 'true'
        ORDER BY created_at DESC
        LIMIT 100`
    );
    waitingInvoices = res.rows;
    log(`  ℹ waiting invoices in DB: ${waitingInvoices.length}`);
    if (waitingInvoices.length === 0) {
      log("  ✓ No invoices currently held — gate idle");
    } else {
      for (const inv of waitingInvoices.slice(0, 10)) {
        const waitIds = inv.metadata?.waiting_variant_ids ?? [];
        log(
          `     • INV-${inv.invoice_number ?? "?"} (${inv.id.slice(
            0,
            10
          )}…) — ${waitIds.length} variant(s) waiting, created ${inv.created_at.toISOString?.() ?? inv.created_at}`
        );
      }
    }
  } catch (e: any) {
    err("  ✗ Query failed:", e.message);
    failures++;
  }

  // ── 3. Readiness simulation — same logic as the poller ────────────────
  log("");
  log("[3/5] Simulating poller readiness check for each waiting invoice…");
  let wouldPromote = 0;
  let wouldStillWait = 0;
  for (const inv of waitingInvoices) {
    const waitIds: string[] = inv.metadata?.waiting_variant_ids ?? [];
    const payload = inv.metadata?.qb_dispatch_payload;

    if (!payload) {
      warn(
        `  ⚠ INV-${inv.invoice_number ?? "?"} has no qb_dispatch_payload — poller would clear flag with error state`
      );
      continue;
    }
    if (waitIds.length === 0) {
      log(
        `  ℹ INV-${inv.invoice_number ?? "?"} has empty waiting_variant_ids — would dispatch immediately`
      );
      wouldPromote++;
      continue;
    }
    try {
      const vRes = await client.query(
        `SELECT id, metadata FROM product_variant WHERE id = ANY($1::text[])`,
        [waitIds]
      );
      const stillMissing = vRes.rows
        .filter((v) => !v.metadata?.quickbooks_id)
        .map((v) => v.id);
      if (stillMissing.length === 0) {
        wouldPromote++;
        log(
          `  ✓ INV-${inv.invoice_number ?? "?"} READY — ${waitIds.length} variant(s) have ListID, next tick will promote`
        );
      } else {
        wouldStillWait++;
        log(
          `  ⏳ INV-${inv.invoice_number ?? "?"} still waiting on ${stillMissing.length}/${waitIds.length} variant(s)`
        );
      }
    } catch (e: any) {
      err(
        `  ✗ Could not evaluate INV-${inv.invoice_number ?? "?"}:`,
        e.message
      );
      failures++;
    }
  }
  if (waitingInvoices.length > 0) {
    log(
      `  Summary — next cron tick: promote=${wouldPromote}, stillWait=${wouldStillWait}`
    );
  }

  // ── 4. Spot-check: recent sold-variants lacking qb_id ────────────────
  log("");
  log("[4/5] Spot-check: recent pos_invoice_items (last 48h) missing qb_id?");
  try {
    const res = await client.query(
      `SELECT DISTINCT pii.variant_id, pv.sku, pv.metadata->>'quickbooks_id' AS qb_id
         FROM pos_invoice_item pii
         JOIN pos_invoice pi ON pi.id = pii.invoice_id
         JOIN product_variant pv ON pv.id = pii.variant_id
        WHERE pi.created_at > NOW() - INTERVAL '48 hours'
          AND (pv.metadata->>'quickbooks_id' IS NULL OR pv.metadata->>'quickbooks_id' = '')
        LIMIT 20`
    );
    if (res.rows.length === 0) {
      log(
        "  ✓ No recently-sold variants lack a quickbooks_id — gate is not firing on legitimate items"
      );
    } else {
      warn(
        `  ⚠ Found ${res.rows.length} recently-sold variant(s) without quickbooks_id:`
      );
      for (const r of res.rows) {
        warn(`     • variant=${r.variant_id} sku=${r.sku ?? "?"}`);
      }
    }
  } catch (e: any) {
    err("  ✗ Query failed:", e.message);
    failures++;
  }

  // ── 5. Schema sanity ─────────────────────────────────────────────────
  log("");
  log("[5/5] Schema sanity…");
  try {
    const res = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE (table_name = 'pos_invoice' AND column_name = 'metadata')
           OR (table_name = 'product_variant' AND column_name = 'metadata')`
    );
    const has = (t: string) =>
      res.rows.some((c) => c.table_name === t && c.column_name === "metadata");
    if (has("pos_invoice")) log("  ✓ pos_invoice.metadata exists");
    else {
      err("  ✗ pos_invoice.metadata missing");
      failures++;
    }
    if (has("product_variant")) log("  ✓ product_variant.metadata exists");
    else {
      err("  ✗ product_variant.metadata missing");
      failures++;
    }
  } catch (e: any) {
    err("  ✗ Schema query failed:", e.message);
    failures++;
  }

  await client.end();

  // ── Summary ──────────────────────────────────────────────────────────
  log("");
  log("═══════════════════════════════════════════════════════════════");
  if (failures === 0) {
    log(`✅ All checks passed. Gate is wired correctly.`);
  } else {
    err(`❌ ${failures} check(s) failed.`);
    process.exitCode = 1;
  }
  log("═══════════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(PREFIX, "fatal:", e);
  process.exitCode = 1;
});
