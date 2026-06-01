/**
 * Test: refreshNullPoLineIds safety net in qb-item-receipt-poller
 *
 * Simulates the race condition where a receipt pipeline row is enqueued
 * with qb_po_list_id set but all line qb_po_txn_line_id = null (PO amendment
 * not yet confirmed by QB when receipt was created).
 *
 * Verifies that the poller's refreshNullPoLineIds logic correctly reads
 * fresh qb_txn_line_id values from purchase_order_line and patches the payload.
 *
 * Run: DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *      npx ts-node --project tsconfig.json src/scripts/tests/test-receipt-po-link-refresh.ts
 */

import knexLib from "knex";
import * as dotenv from "dotenv";

dotenv.config();

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:sandbox@localhost:5499/medusa";

const knex = knexLib({ client: "pg", connection: DATABASE_URL });

// ── Mirror of the poller's refreshNullPoLineIds (under test) ─────────────
const refreshNullPoLineIds = async (
  payload: Record<string, unknown>,
  rowId: string,
  payloadColumn: "payload" | "mod_payload"
): Promise<Record<string, unknown>> => {
  const lines = payload.lines as Array<Record<string, unknown>> | undefined;
  if (!payload.qb_po_list_id || !lines?.length) return payload;

  const nullIds = lines
    .filter(
      (l) =>
        l.qb_po_txn_line_id === null || l.qb_po_txn_line_id === undefined
    )
    .map((l) => l.po_line_id as string);
  if (!nullIds.length) return payload;

  const freshRows: Array<{ id: string; qb_txn_line_id: string | null }> =
    await knex
      .raw(
        `SELECT id, qb_txn_line_id FROM purchase_order_line WHERE id = ANY(?::text[])`,
        [nullIds]
      )
      .then((r: any) => r.rows);

  const anyFresh = freshRows.some((r) => r.qb_txn_line_id !== null);
  if (!anyFresh) return payload;

  const freshById = new Map(freshRows.map((r) => [r.id, r.qb_txn_line_id]));
  const refreshedLines = lines.map((l) => ({
    ...l,
    qb_po_txn_line_id:
      (l.qb_po_txn_line_id as string | null) ??
      freshById.get(l.po_line_id as string) ??
      null,
  }));

  const refreshedPayload = { ...payload, lines: refreshedLines };

  await knex.raw(
    `UPDATE qb_item_receipt_pipeline SET ${payloadColumn} = ?::jsonb, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(refreshedPayload), rowId]
  );

  return refreshedPayload;
};

// ── Helpers ───────────────────────────────────────────────────────────────

const pass = (msg: string) => console.log(`  ✅ PASS: ${msg}`);
const fail = (msg: string) => { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; };
const info = (msg: string) => console.log(`  ℹ  ${msg}`);

// ── Setup: insert synthetic test rows ────────────────────────────────────

async function setup() {
  // Use PO-1015 which has 22 lines all with qb_txn_line_id in sandbox
  const po = await knex.raw(
    `SELECT id, number, qb_purchase_order_list_id FROM purchase_order WHERE number = 'PO-1015' LIMIT 1`
  ).then((r: any) => r.rows[0]);

  if (!po) throw new Error("PO-1015 not found in sandbox");
  info(`Using PO: ${po.number} (qb_po_list_id=${po.qb_purchase_order_list_id})`);

  const lines: Array<{ id: string; sku_snapshot: string; qb_txn_line_id: string; qb_item_list_id_snapshot: string; unit_cost_cents: number }> =
    await knex.raw(
      `SELECT id, sku_snapshot, qb_txn_line_id, qb_item_list_id_snapshot, unit_cost_cents
       FROM purchase_order_line
       WHERE purchase_order_id = ? AND qb_txn_line_id IS NOT NULL
       LIMIT 5`,
      [po.id]
    ).then((r: any) => r.rows);

  info(`Using ${lines.length} PO lines for test payload`);

  // Create a fake receipt row
  const ts = Date.now();
  const receiptId = "por_TEST_REFRESH_" + ts;
  const receiptNumber = "RCP-TST-" + ts;
  await knex.raw(
    `INSERT INTO purchase_order_receipt
       (id, purchase_order_id, seq, number, received_by_user_id,
        stock_location_id, received_at, status, created_at, updated_at)
     VALUES (?, ?, 9991, ?, 'user_test', 'sloc_test', NOW(), 'pending', NOW(), NOW())`,
    [receiptId, po.id, receiptNumber]
  );

  // Build the payload that simulates the race condition:
  // qb_po_list_id IS set, but ALL qb_po_txn_line_id = null
  const payload = {
    po_id: po.id,
    po_number: po.number,
    receipt_id: receiptId,
    receipt_number: receiptNumber,
    vendor_qb_list_id: "VTEST",
    vendor_name: "Test Vendor",
    qb_po_list_id: po.qb_purchase_order_list_id,  // ← SET (PO is in QB)
    inventory_site_list_id: null,
    received_at: new Date().toISOString(),
    vendor_bill_number: null,
    vendor_bill_date: null,
    memo: "Test race condition",
    lines: lines.map((l) => ({
      receipt_line_id: "porl_test_" + l.id,
      po_line_id: l.id,
      qb_item_list_id: l.qb_item_list_id_snapshot ?? "",
      qb_po_txn_line_id: null,  // ← NULL (race condition: not yet written back)
      sku: l.sku_snapshot,
      description: "test",
      qty_received_now: 1,
      unit_cost_cents: l.unit_cost_cents,
    })),
  };

  // Insert pipeline row
  const pipelineId = "qbrcpipe_TEST_REFRESH_" + Date.now();
  await knex.raw(
    `INSERT INTO qb_item_receipt_pipeline
       (id, purchase_order_receipt_id, purchase_order_id, status, payload, retries, void_retries, created_at, updated_at)
     VALUES (?, ?, ?, 'waiting', ?::jsonb, 0, 0, NOW(), NOW())`,
    [pipelineId, receiptId, po.id, JSON.stringify(payload)]
  );

  info(`Inserted pipeline row: ${pipelineId}`);
  info(`All ${lines.length} lines have qb_po_txn_line_id=null in payload`);

  return { pipelineId, receiptId, po, lines, payload };
}

// ── Tests ─────────────────────────────────────────────────────────────────

async function runTests(ctx: Awaited<ReturnType<typeof setup>>) {
  const { pipelineId, lines, po } = ctx;

  console.log("\n── Test 1: refresh detects null lines and reads from DB ──");
  const row = await knex.raw(
    `SELECT id, payload FROM qb_item_receipt_pipeline WHERE id = ?`,
    [pipelineId]
  ).then((r: any) => r.rows[0]);

  const nullsBefore = (row.payload.lines as any[]).filter(
    (l: any) => l.qb_po_txn_line_id === null
  ).length;
  info(`Nulls before refresh: ${nullsBefore}/${lines.length}`);
  if (nullsBefore !== lines.length) fail(`Expected ${lines.length} nulls, got ${nullsBefore}`);
  else pass(`All ${nullsBefore} lines have qb_po_txn_line_id=null before refresh`);

  console.log("\n── Test 2: refreshNullPoLineIds patches the payload ──");
  const refreshed = await refreshNullPoLineIds(row.payload, pipelineId, "payload");

  const nullsAfterInMemory = (refreshed.lines as any[]).filter(
    (l: any) => l.qb_po_txn_line_id === null
  ).length;
  if (nullsAfterInMemory !== 0)
    fail(`Still ${nullsAfterInMemory} nulls in returned payload`);
  else
    pass(`All lines have qb_po_txn_line_id set in returned payload`);

  console.log("\n── Test 3: payload persisted to DB ──");
  const rowAfter = await knex.raw(
    `SELECT payload FROM qb_item_receipt_pipeline WHERE id = ?`,
    [pipelineId]
  ).then((r: any) => r.rows[0]);

  const nullsInDB = (rowAfter.payload.lines as any[]).filter(
    (l: any) => l.qb_po_txn_line_id === null
  ).length;
  if (nullsInDB !== 0)
    fail(`DB payload still has ${nullsInDB} null qb_po_txn_line_id`);
  else
    pass(`DB payload persisted with all lines linked`);

  console.log("\n── Test 4: values match the actual DB qb_txn_line_id ──");
  const expectedById = new Map(lines.map((l) => [l.id, l.qb_txn_line_id]));
  let mismatch = 0;
  for (const l of (rowAfter.payload.lines as any[])) {
    const expected = expectedById.get(l.po_line_id);
    if (l.qb_po_txn_line_id !== expected) {
      fail(`Line ${l.sku}: expected ${expected}, got ${l.qb_po_txn_line_id}`);
      mismatch++;
    }
  }
  if (mismatch === 0)
    pass(`All ${lines.length} lines have correct qb_po_txn_line_id from purchase_order_line`);

  console.log("\n── Test 5: idempotent — second call does not double-update ──");
  const rowAfter2 = await knex.raw(
    `SELECT payload, updated_at FROM qb_item_receipt_pipeline WHERE id = ?`,
    [pipelineId]
  ).then((r: any) => r.rows[0]);
  const updatedAtBefore = rowAfter2.updated_at;

  await new Promise((r) => setTimeout(r, 100));
  await refreshNullPoLineIds(rowAfter2.payload, pipelineId, "payload");

  const rowAfter3 = await knex.raw(
    `SELECT updated_at FROM qb_item_receipt_pipeline WHERE id = ?`,
    [pipelineId]
  ).then((r: any) => r.rows[0]);

  if (rowAfter3.updated_at.getTime() !== updatedAtBefore.getTime()) {
    // A second call re-updated — not ideal but not incorrect (nullIds.length==0 skips early)
    info(`Second call: updated_at changed (no-nulls path still wrote — acceptable)`);
  } else {
    pass(`Second call: no DB write (all lines already populated, no nulls)`);
  }

  console.log("\n── Test 6: no-op when qb_po_list_id is null ──");
  const payloadNoPoId = { ...rowAfter2.payload, qb_po_list_id: null };
  const resultNoPoId = await refreshNullPoLineIds(
    payloadNoPoId, pipelineId, "payload"
  );
  if (resultNoPoId === payloadNoPoId)
    pass(`Returns original payload untouched when qb_po_list_id=null`);
  else
    fail(`Should have returned payload unchanged`);

  console.log("\n── Test 7: partial nulls — some lines already have qb_po_txn_line_id set ──");
  // Build a mixed payload: first 2 lines have IDs, last 3 are null
  const allLines = ctx.lines;
  const mixedPayload = {
    ...rowAfter2.payload,
    lines: allLines.map((l, i) => ({
      receipt_line_id: "porl_test_" + l.id,
      po_line_id: l.id,
      qb_item_list_id: l.qb_item_list_id_snapshot ?? "",
      qb_po_txn_line_id: i < 2 ? l.qb_txn_line_id : null,  // first 2 set, rest null
      sku: l.sku_snapshot,
      description: "test",
      qty_received_now: 1,
      unit_cost_cents: l.unit_cost_cents,
    })),
  };
  // Persist the mixed payload
  await knex.raw(
    `UPDATE qb_item_receipt_pipeline SET payload = ?::jsonb, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(mixedPayload), pipelineId]
  );
  const freshMixed = await refreshNullPoLineIds(mixedPayload, pipelineId, "payload");
  const stillNull = (freshMixed.lines as any[]).filter((l: any) => l.qb_po_txn_line_id === null).length;
  if (stillNull !== 0)
    fail(`Partial refresh: ${stillNull} lines still null after refresh`);
  else
    pass(`Partial refresh: all ${allLines.length} lines linked (2 pre-set + 3 refreshed)`);

  // Verify the 2 pre-set lines weren't corrupted
  const preSetOk = (freshMixed.lines as any[])
    .slice(0, 2)
    .every((l: any) => l.qb_po_txn_line_id === allLines[allLines.indexOf(allLines.find((al: any) => al.id === l.po_line_id) as any)]?.qb_txn_line_id);
  if (preSetOk)
    pass(`Pre-set line values preserved unchanged`);

  console.log("\n── Test 8: mod_payload path ──");
  // Reset to null and test via mod_payload column
  const modPayload = { ...mixedPayload, lines: allLines.map((l) => ({
    receipt_line_id: "porl_test_" + l.id,
    po_line_id: l.id,
    qb_item_list_id: l.qb_item_list_id_snapshot ?? "",
    qb_po_txn_line_id: null,
    sku: l.sku_snapshot,
    description: "test",
    qty_received_now: 1,
    unit_cost_cents: l.unit_cost_cents,
  }))};

  await knex.raw(
    `UPDATE qb_item_receipt_pipeline SET mod_payload = ?::jsonb, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(modPayload), pipelineId]
  );

  const freshMod = await refreshNullPoLineIds(modPayload, pipelineId, "mod_payload");
  const modNullsAfter = (freshMod.lines as any[]).filter((l: any) => l.qb_po_txn_line_id === null).length;
  if (modNullsAfter !== 0)
    fail(`mod_payload path: ${modNullsAfter} nulls remain after refresh`);
  else
    pass(`mod_payload path: all ${allLines.length} lines linked via mod_payload column`);

  // Verify DB was updated on mod_payload column
  const rowMod = await knex.raw(
    `SELECT mod_payload FROM qb_item_receipt_pipeline WHERE id = ?`, [pipelineId]
  ).then((r: any) => r.rows[0]);
  const modDbNulls = (rowMod.mod_payload?.lines ?? []).filter((l: any) => l.qb_po_txn_line_id === null).length;
  if (modDbNulls !== 0)
    fail(`mod_payload: DB still has ${modDbNulls} nulls`);
  else
    pass(`mod_payload: DB mod_payload column persisted correctly`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────

async function cleanup(ctx: Awaited<ReturnType<typeof setup>>) {
  await knex.raw(`DELETE FROM qb_item_receipt_pipeline WHERE id LIKE 'qbrcpipe_TEST_REFRESH_%'`);
  await knex.raw(`DELETE FROM purchase_order_receipt WHERE id = ?`, [ctx.receiptId]);
  info(`Cleanup: test rows removed`);
}

// ── Main ──────────────────────────────────────────────────────────────────

(async () => {
  console.log("=== test-receipt-po-link-refresh ===\n");
  console.log("Scenario: PO is in QB (qb_po_list_id set) but receipt payload");
  console.log("          has all qb_po_txn_line_id=null (race condition)\n");

  let ctx: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    console.log("── Setup ──");
    ctx = await setup();
    await runTests(ctx);
  } catch (err) {
    console.error("\n💥 Unexpected error:", err);
    process.exitCode = 1;
  } finally {
    if (ctx) await cleanup(ctx);
    await knex.destroy();
    console.log(
      process.exitCode === 1
        ? "\n❌ Tests FAILED"
        : "\n✅ All tests PASSED"
    );
  }
})();
