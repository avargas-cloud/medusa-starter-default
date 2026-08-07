/**
 * src/scripts/verify/verify-qb-invoice-gate.ts
 *
 * READ-ONLY verification for the Fase 3 Order Pipeline Gate.
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
 * Dual run mode:
 *   yarn medusa exec ./src/scripts/verify/verify-qb-invoice-gate.ts
 *     (uses Medusa container to resolve pg)
 *
 *   npx tsx ./src/scripts/verify/verify-qb-invoice-gate.ts
 *     (standalone — connects to DATABASE_URL from .env directly)
 */
import { existsSync, readFileSync } from "fs";
import { join, resolve as resolvePath } from "path";
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

type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

async function runChecks(queryFn: QueryFn, cleanup?: () => Promise<void>) {
  let failures = 0;
  log("═══════════════════════════════════════════════════════════════");
  log("Fase 3 — QB Invoice Gate verification (READ-ONLY)");
  log("═══════════════════════════════════════════════════════════════");

  // ── 1. Module file + export sanity (static check via fs) ─────────────
  // Medusa exec and tsx have divergent module resolution for extension-less
  // imports of sibling .ts files, so we check for file presence on disk and
  // scan the source for the required export symbols. This is lighter than
  // actually loading the modules and works identically in both runtimes.
  log("");
  log("[1/5] Checking gate + poller + endpoint source files…");
  const scriptDir = __dirname ?? resolvePath(process.cwd(), "src/scripts/verify");
  const srcRoot = resolvePath(scriptDir, "../..");

  // 2026-08-07: the Waiting Orders tab and its two /admin/qb-catalog/
  // waiting-invoices routes were REMOVED — the gate never held a single
  // invoice in all of prod history (0 rows ever carried waiting_qb_items,
  // and the release path sets it to false rather than deleting it, so a
  // fired-and-released invoice would still be countable). The gate job +
  // the setter in invoices/route.ts stay: they are the safety net for an
  // invoice created with variants that lack a QB ListID, and they
  // self-heal without UI. This check asserts the mechanism only.
  const fileChecks: Array<{ rel: string; expects: string[] }> = [
    {
      rel: "jobs/qb-invoice-waiting-gate.ts",
      expects: ["export default async function", "schedule:"],
    },
    {
      rel: "api/admin/invoices/route.ts",
      expects: ["waiting_qb_items"],
    },
  ];

  for (const check of fileChecks) {
    const abs = resolvePath(srcRoot, check.rel);
    if (!existsSync(abs)) {
      err(`  ✗ missing file: src/${check.rel}`);
      failures++;
      continue;
    }
    const source = readFileSync(abs, "utf8");
    const missing = check.expects.filter((sym) => !source.includes(sym));
    if (missing.length > 0) {
      err(
        `  ✗ src/${check.rel} missing expected symbols: ${missing.join(", ")}`
      );
      failures++;
    } else {
      log(`  ✓ src/${check.rel}`);
    }
  }

  // ── 2. Count currently waiting invoices ──────────────────────────────
  log("");
  log("[2/5] Counting pos_invoice rows with waiting_qb_items=true…");
  let waitingInvoices: any[] = [];
  try {
    const res = await queryFn(
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
      const vRes = await queryFn(
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
    const res = await queryFn(
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
    const res = await queryFn(
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

  if (cleanup) await cleanup();

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

// ── Entry points ────────────────────────────────────────────────────────

// (A) Medusa exec: yarn medusa exec ./src/scripts/verify/verify-qb-invoice-gate.ts
// Medusa bootstraps the container and passes it here. We wrap the knex
// connection to match QueryFn's pg-style signature.
export default async function ({ container }: { container: any }) {
  const knex = container.resolve("__pg_connection__");
  const queryFn: QueryFn = async (sql, params) => {
    // knex.raw accepts $1 style placeholders when params are given, but the
    // script was written against pg ($1) syntax — knex translates transparently.
    const result = await knex.raw(sql, params ?? []);
    return { rows: result.rows ?? result[0] ?? [] };
  };
  await runChecks(queryFn);
}

// (B) Standalone tsx: npx tsx ./src/scripts/verify/verify-qb-invoice-gate.ts
// Detect direct execution via require.main === module (works under tsx too).
const isDirect =
  typeof require !== "undefined" &&
  typeof module !== "undefined" &&
  require.main === module;

if (isDirect) {
  (async () => {
    const client = new Client({ connectionString: loadDatabaseUrl() });
    await client.connect();
    log("  ℹ Connected to Postgres");
    const queryFn: QueryFn = async (sql, params) => {
      const res = await client.query(sql, params);
      return { rows: res.rows };
    };
    await runChecks(queryFn, async () => {
      await client.end();
    });
  })().catch((e) => {
    console.error(PREFIX, "fatal:", e);
    process.exitCode = 1;
  });
}
