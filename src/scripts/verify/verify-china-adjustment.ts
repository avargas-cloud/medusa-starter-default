/**
 * scripts/verify/verify-china-adjustment.ts
 *
 * End-to-end test for POST /admin/china-adjustment.
 * Uses a real item with China stock, adjusts it, checks DB, then reverts.
 *
 * Run: npx ts-node -e "require('./src/scripts/verify/verify-china-adjustment.ts')"
 * Or:  npx tsx src/scripts/verify/verify-china-adjustment.ts
 */

import "dotenv/config";
import { Client } from "pg";

// ── Config ────────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000";
const CHINA_LOCATION_ID = "sloc_01KQ14C1CFX30EDD722BF87HDM";

// Test item: ECN-EDG-PIGD-10 (high China stock — safe for testing)
const TEST_ITEM = {
  inventory_item_id: "iitem_01KFS1G4TBTQK10N5Q5FB62X1Q",
  sku: "ECN-EDG-PIGD-10",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(msg: string) {
  console.log(`  ✅  ${msg}`);
}
function fail(msg: string) {
  console.error(`  ❌  ${msg}`);
  process.exit(1);
}
function info(msg: string) {
  console.log(`  ℹ   ${msg}`);
}

async function getChineseStock(db: Client, inventoryItemId: string): Promise<number> {
  const res = await db.query(
    `SELECT stocked_quantity FROM inventory_level
     WHERE inventory_item_id = $1 AND location_id = $2`,
    [inventoryItemId, CHINA_LOCATION_ID]
  );
  return (res.rows[0]?.stocked_quantity as number) ?? 0;
}

async function getAdminToken(): Promise<string> {
  const email    = process.env.TEST_ADMIN_EMAIL    ?? "a.vargas@ecopowertech.com";
  const password = process.env.TEST_ADMIN_PASSWORD ?? process.env.MEDUSA_ADMIN_PASSWORD ?? "";

  if (!password) {
    fail("Set TEST_ADMIN_PASSWORD (or MEDUSA_ADMIN_PASSWORD) in .env before running this script.");
    process.exit(1);
  }

  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    fail(`Auth failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) fail("No token in auth response.");
  return data.token!;
}

async function callAdjustment(
  token: string,
  lines: { inventory_item_id: string; sku: string; new_quantity: number }[],
  notes?: string
) {
  const res = await fetch(`${BACKEND_URL}/admin/china-adjustment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ lines, notes }),
  });

  const body = await res.json() as { adjustment?: { id: string; lines: unknown[] }; error?: string };

  if (!res.ok) {
    fail(`POST /admin/china-adjustment failed (${res.status}): ${body.error ?? JSON.stringify(body)}`);
    process.exit(1);
  }

  return body;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔬  verify-china-adjustment — end-to-end test\n");

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // ── Step 1: snapshot original stock ────────────────────────────────────────
  const originalQty = await getChineseStock(db, TEST_ITEM.inventory_item_id);
  info(`Original China stock for ${TEST_ITEM.sku}: ${originalQty}`);

  // ── Step 2: authenticate ────────────────────────────────────────────────────
  info("Authenticating as admin…");
  const token = await getAdminToken();
  pass("Token obtained");

  // ── Step 3: set to originalQty + 7 (arbitrary change) ──────────────────────
  const targetQty = originalQty + 7;
  info(`Setting stock to ${targetQty} (+7 from original)…`);

  const createRes = await callAdjustment(
    token,
    [{ ...TEST_ITEM, new_quantity: targetQty }],
    "verify-china-adjustment test — do not delete"
  );

  const adjId = createRes.adjustment?.id;
  if (!adjId) fail("Response missing adjustment.id");
  pass(`Adjustment created — id: ${adjId}`);

  // ── Step 4: verify DB stock changed ────────────────────────────────────────
  const afterQty = await getChineseStock(db, TEST_ITEM.inventory_item_id);
  info(`DB stocked_quantity after adjustment: ${afterQty}`);

  if (afterQty !== targetQty) {
    fail(`Expected ${targetQty}, got ${afterQty} — inventory_level was NOT updated!`);
  }
  pass(`inventory_level.stocked_quantity = ${afterQty} ✓`);

  // ── Step 5: verify audit row exists in china_adjustment_line ───────────────
  const lineRes = await db.query(
    `SELECT cl.old_qty, cl.new_qty, cl.delta
     FROM china_adjustment_line cl
     WHERE cl.china_adjustment_id = $1 AND cl.sku = $2`,
    [adjId, TEST_ITEM.sku]
  );
  if (lineRes.rowCount === 0) fail("No china_adjustment_line row found for this adjustment.");

  const line = lineRes.rows[0] as { old_qty: number; new_qty: number; delta: number };
  if (line.old_qty !== originalQty) fail(`Audit old_qty mismatch: expected ${originalQty}, got ${line.old_qty}`);
  if (line.new_qty !== targetQty)   fail(`Audit new_qty mismatch: expected ${targetQty}, got ${line.new_qty}`);
  if (line.delta   !== 7)           fail(`Audit delta mismatch: expected 7, got ${line.delta}`);
  pass(`Audit line correct — old=${line.old_qty} → new=${line.new_qty} (delta=${line.delta})`);

  // ── Step 6: GET /admin/china-adjustment/:id round-trip ─────────────────────
  const getRes = await fetch(`${BACKEND_URL}/admin/china-adjustment/${adjId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!getRes.ok) fail(`GET /admin/china-adjustment/${adjId} failed (${getRes.status})`);
  const getBody = await getRes.json() as { adjustment: { id: string }; lines: unknown[] };
  if (getBody.adjustment.id !== adjId) fail("GET response id mismatch");
  if (!Array.isArray(getBody.lines) || getBody.lines.length === 0) fail("GET response missing lines");
  pass(`GET /admin/china-adjustment/${adjId} returns document with ${getBody.lines.length} line(s)`);

  // ── Step 7: revert to original ─────────────────────────────────────────────
  info(`Reverting ${TEST_ITEM.sku} back to ${originalQty}…`);
  await callAdjustment(
    token,
    [{ ...TEST_ITEM, new_quantity: originalQty }],
    "verify-china-adjustment revert"
  );
  const revertedQty = await getChineseStock(db, TEST_ITEM.inventory_item_id);
  if (revertedQty !== originalQty) fail(`Revert failed — expected ${originalQty}, got ${revertedQty}`);
  pass(`Stock reverted to ${revertedQty} ✓`);

  // ── Done ───────────────────────────────────────────────────────────────────
  await db.end();
  console.log("\n✅  All checks passed — china-adjustment is working correctly.\n");
}

main().catch((err) => {
  console.error("\n💥  Unexpected error:", err);
  process.exit(1);
});
