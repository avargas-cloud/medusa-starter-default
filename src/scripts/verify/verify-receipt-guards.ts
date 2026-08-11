/**
 * src/scripts/verify/verify-receipt-guards.ts
 *
 * READ-ONLY verification for the receipt-emptying / in-flight-ADD /
 * receipt-history guards shipped 2026-08-11 (prod incident: a receipt
 * reached 0 lines, another lost its receipt history to the FK CASCADE on
 * `purchase_order_receipt_line.purchase_order_line_id`).
 *
 * Checks nothing more than "the fix is present" — this is a static/DB-shape
 * gate, not a functional E2E. Each check prints what its failure would mean.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-receipt-guards.ts
 * (standalone — connects to DATABASE_URL from .env directly, does not need
 * `medusa exec`.)
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";

const PREFIX = "[verify-receipt-guards]";
const log = (...args: unknown[]) => console.log(PREFIX, ...args);
const err = (...args: unknown[]) => console.error(PREFIX, ...args);

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(process.cwd(), ".env");
  const content = readFileSync(envPath, "utf8");
  const match = content.match(/^DATABASE_URL=(.+)$/m);
  if (!match) {
    throw new Error("DATABASE_URL not set and not found in .env");
  }
  return match[1].trim().replace(/^["']|["']$/g, "");
}

const RECEIPT_ROUTE = join(
  process.cwd(),
  "src/api/admin/purchase-orders/[id]/receipts/[receiptId]/route.ts"
);
const PO_ROUTE = join(process.cwd(), "src/api/admin/purchase-orders/[id]/route.ts");

async function main(): Promise<void> {
  let failures = 0;

  log("═══════════════════════════════════════════════════════════");
  log("Receipt guards verification (READ-ONLY)");
  log("═══════════════════════════════════════════════════════════");

  // ── Check 1: FK constraints are RESTRICT ─────────────────────────────────
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT conname, confdeltype
         FROM pg_constraint
        WHERE conname IN ('FK_porl_po_line_id', 'FK_forl_fo_line_id')`
    );
    const byName = new Map(
      (res.rows as Array<{ conname: string; confdeltype: string }>).map(
        (r) => [r.conname, r.confdeltype]
      )
    );
    for (const name of ["FK_porl_po_line_id", "FK_forl_fo_line_id"]) {
      const deltype = byName.get(name);
      if (deltype === "r") {
        log(`PASS check 1 (${name} is ON DELETE RESTRICT)`);
      } else {
        failures++;
        err(
          `FAIL check 1 (${name}): confdeltype='${deltype ?? "MISSING"}', expected 'r'. ` +
            `If this fails, deleting a PO/FO line still CASCADEs and silently vaporizes ` +
            `receipt lines (and possibly the whole receipt) — the exact prod incident this ` +
            `migration exists to close. Run Migration20260811230000.`
        );
      }
    }
  } finally {
    await client.end();
  }

  // ── Check 2: receipt PATCH source has both new error codes ───────────────
  const receiptSrc = readFileSync(RECEIPT_ROUTE, "utf8");
  for (const code of ["receipt_would_be_empty", "add_in_flight"]) {
    if (receiptSrc.includes(code)) {
      log(`PASS check 2 (receipt PATCH contains code '${code}')`);
    } else {
      failures++;
      err(
        `FAIL check 2 (receipt PATCH missing code '${code}'): if this fails, either the ` +
          `all-zero-total guard (G1) or the ADD-in-flight guard (G2) was removed/renamed — ` +
          `an edit could again leave a receipt at 0 units, or race a submitting ItemReceiptAdd.`
      );
    }
  }

  // ── Check 3: PO PATCH source has the receipt-history guard ───────────────
  const poSrc = readFileSync(PO_ROUTE, "utf8");
  if (poSrc.includes("has receipt history")) {
    log("PASS check 3 (PO PATCH contains the receipt-history guard message)");
  } else {
    failures++;
    err(
      "FAIL check 3 (PO PATCH missing 'has receipt history'): if this fails, deleting a PO " +
        "line with live receipt lines returns a raw FK-violation 500 from the new RESTRICT " +
        "constraint instead of an actionable 409 (code 'line_locked')."
    );
  }

  // ── Check 4: DELETE no longer hard-blocks on nothing_to_reverse ──────────
  const deleteHandlerMatch = receiptSrc.match(
    /export async function DELETE\([\s\S]*?\n}\n/
  );
  const deleteHandlerSrc = deleteHandlerMatch?.[0] ?? receiptSrc;
  if (!deleteHandlerSrc.includes("nothing_to_reverse")) {
    log(
      "PASS check 4 (DELETE handler no longer returns the 'nothing_to_reverse' 409)"
    );
  } else {
    failures++;
    err(
      "FAIL check 4 (DELETE handler still contains 'nothing_to_reverse'): if this fails, a " +
        "receipt with 0 stock-applied lines (all lines edited to 0 via PATCH, or created " +
        "empty) is permanently un-deletable again — the receipt is stuck forever, which is " +
        "the second half of the prod incident this script guards against."
    );
  }

  log("═══════════════════════════════════════════════════════════");
  if (failures > 0) {
    err(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  log("All checks PASSED");
}

main().catch((e) => {
  err("Unhandled error:", e);
  process.exit(1);
});
