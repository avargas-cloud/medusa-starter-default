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
  return Number(res.rows[0]?.stocked_quantity ?? 0);
}

/** China reserved (committed + in_transit). new_quantity is an AVAILABLE-basis
 *  count, so the operator enters stocked − reserved and the backend re-adds it. */
async function getChineseReserved(db: Client, inventoryItemId: string): Promise<number> {
  const res = await db.query(
    `SELECT COALESCE(reserved_quantity, 0) AS reserved FROM inventory_level
     WHERE inventory_item_id = $1 AND location_id = $2`,
    [inventoryItemId, CHINA_LOCATION_ID]
  );
  return Number(res.rows[0]?.reserved ?? 0);
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

  // ── Step 1: snapshot original stock + reserved (available basis) ───────────
  const originalStocked = await getChineseStock(db, TEST_ITEM.inventory_item_id);
  const reserved = await getChineseReserved(db, TEST_ITEM.inventory_item_id);
  const originalAvailable = originalStocked - reserved;
  info(`${TEST_ITEM.sku}: stocked=${originalStocked}, reserved=${reserved}, available=${originalAvailable}`);

  // ── Step 2: authenticate ────────────────────────────────────────────────────
  info("Authenticating as admin…");
  const token = await getAdminToken();
  pass("Token obtained");

  // ── Step 3: enter available + 7 (operator counts the loose shelf) ──────────
  // new_quantity is an AVAILABLE count; the backend re-adds reserved on top, so
  // stocked must land at originalStocked + 7 (reserved preserved).
  const targetAvailable = originalAvailable + 7;
  const targetStocked = originalStocked + 7;
  info(`Entering available count ${targetAvailable} (+7) → expected stocked ${targetStocked}…`);

  const createRes = await callAdjustment(
    token,
    [{ ...TEST_ITEM, new_quantity: targetAvailable }],
    "verify-china-adjustment test — do not delete"
  );

  const adjId = createRes.adjustment?.id;
  if (!adjId) fail("Response missing adjustment.id");
  pass(`Adjustment created — id: ${adjId}`);

  // ── Step 4: verify DB stock changed (reserved preserved) ───────────────────
  const afterQty = await getChineseStock(db, TEST_ITEM.inventory_item_id);
  info(`DB stocked_quantity after adjustment: ${afterQty}`);

  if (afterQty !== targetStocked) {
    fail(`Expected stocked ${targetStocked} (available ${targetAvailable} + reserved ${reserved}), got ${afterQty}!`);
  }
  pass(`inventory_level.stocked_quantity = ${afterQty} ✓ (reserved ${reserved} preserved)`);

  // ── Step 5: verify audit row (available basis) ─────────────────────────────
  const lineRes = await db.query(
    `SELECT cl.old_qty, cl.new_qty, cl.delta
     FROM china_adjustment_line cl
     WHERE cl.china_adjustment_id = $1 AND cl.sku = $2`,
    [adjId, TEST_ITEM.sku]
  );
  if (lineRes.rowCount === 0) fail("No china_adjustment_line row found for this adjustment.");

  const line = lineRes.rows[0] as { old_qty: number; new_qty: number; delta: number };
  if (line.old_qty !== originalAvailable) fail(`Audit old_qty mismatch: expected available ${originalAvailable}, got ${line.old_qty}`);
  if (line.new_qty !== targetAvailable)   fail(`Audit new_qty mismatch: expected ${targetAvailable}, got ${line.new_qty}`);
  if (line.delta   !== 7)                 fail(`Audit delta mismatch: expected 7, got ${line.delta}`);
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
  info(`Reverting ${TEST_ITEM.sku} back to available ${originalAvailable} (stocked ${originalStocked})…`);
  await callAdjustment(
    token,
    [{ ...TEST_ITEM, new_quantity: originalAvailable }],
    "verify-china-adjustment revert"
  );
  const revertedQty = await getChineseStock(db, TEST_ITEM.inventory_item_id);
  if (revertedQty !== originalStocked) fail(`Revert failed — expected stocked ${originalStocked}, got ${revertedQty}`);
  pass(`Stock reverted to ${revertedQty} ✓`);

  // ── Done ───────────────────────────────────────────────────────────────────
  await db.end();
  console.log("\n✅  All checks passed — china-adjustment is working correctly.\n");
}

main().catch((err) => {
  console.error("\n💥  Unexpected error:", err);
  process.exit(1);
});
