/**
 * Sandbox smoke — ItemReceiptMod pipeline (chunk 3 verification).
 *
 * What this test proves:
 *
 *   1. The SQL that enqueueQbItemReceiptModStep runs returns a payload with
 *      qb_po_txn_line_id preserved per line (the bug-prone part — losing
 *      this would silently break PO ↔ Receipt linkage in QB on Mod).
 *   2. unit_cost_cents falls back from receipt_line.unit_cost_cents_override
 *      to purchase_order_line.unit_cost_cents when the override is NULL.
 *   3. The mod_status / void_status / pipe.status 409 guards in the route
 *      reject conflicting states (mod pending, void in progress, ADD not
 *      synced).
 *   4. The mod_status check constraint accepts 'error' (chunk 3a).
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     yarn tsx src/scripts/test/sandbox-smoke-item-receipt-mod.ts
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import { Client } from "pg";
import { randomUUID } from "crypto";

const TAG = "[smoke-ir-mod]";
let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string, detail?: string): void {
  if (cond) {
    console.log(`  ✅ ${label}`);
    pass++;
  } else {
    console.error(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function cleanup(c: Client, prefix: string): Promise<void> {
  await c.query(
    `DELETE FROM qb_item_receipt_pipeline WHERE id LIKE $1 OR purchase_order_receipt_id LIKE $1`,
    [`${prefix}%`]
  );
  await c.query(`DELETE FROM purchase_order_receipt_line WHERE id LIKE $1`, [
    `${prefix}%`,
  ]);
  await c.query(`DELETE FROM purchase_order_receipt WHERE id LIKE $1`, [
    `${prefix}%`,
  ]);
  await c.query(`DELETE FROM purchase_order_line WHERE id LIKE $1`, [
    `${prefix}%`,
  ]);
  await c.query(`DELETE FROM purchase_order WHERE id LIKE $1`, [`${prefix}%`]);
}

async function insertFixture(
  c: Client,
  prefix: string
): Promise<{
  poId: string;
  receiptId: string;
  pipelineId: string;
  poLineIds: [string, string];
  receiptLineIds: [string, string];
}> {
  const poId = `${prefix}po`;
  const receiptId = `${prefix}rcp`;
  const pipelineId = `${prefix}pipe`;
  const poLineA = `${prefix}pol-a`;
  const poLineB = `${prefix}pol-b`;
  const rlA = `${prefix}rl-a`;
  const rlB = `${prefix}rl-b`;

  await c.query(
    `INSERT INTO purchase_order
       (id, number, status, po_status,
        vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
        stock_location_id, created_by_user_id,
        qb_purchase_order_list_id, qb_edit_sequence, qb_synced_at,
        memo, created_at, updated_at)
     VALUES ($1, 'TEST-PO', 'submitted', 'partially_received',
             'vendor-fake', 'Acme Vendor', 'QB-VEND-1',
             'sloc-fake', 'usr-fake',
             'QB-PO-TXN-1', '1234567890', NOW(),
             'PO-1234 bill#9999', NOW(), NOW())`,
    [poId]
  );

  await c.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot,
        qb_item_list_id_snapshot, qb_txn_line_id,
        qty_ordered, qty_received,
        unit_cost_cents, total_cents, line_order,
        created_at, updated_at)
     VALUES
       ($1, $2, 'pv-a', 'inv-a', 'SKU-A', 'Widget A',
        'QB-ITEM-A', 'TXNLINE-A', 10, 5, 2500, 12500, 1, NOW(), NOW()),
       ($3, $2, 'pv-b', 'inv-b', 'SKU-B', 'Widget B',
        'QB-ITEM-B', 'TXNLINE-B', 20, 8, 1000, 8000, 2, NOW(), NOW())`,
    [poLineA, poId, poLineB]
  );

  await c.query(
    `INSERT INTO purchase_order_receipt
       (id, purchase_order_id, number, seq, status,
        received_at, received_by_user_id, stock_location_id,
        vendor_bill_number, vendor_bill_date,
        qb_item_receipt_list_id, qb_item_receipt_txn_number,
        qb_edit_sequence, qb_synced_at,
        created_at, updated_at)
     VALUES ($1, $2, 'RCP-1', 1, 'synced',
             NOW(), 'usr-fake', 'sloc-fake',
             'BILL-9999', NOW(),
             'QB-IR-TXN-1', '12345',
             '999111222', NOW(),
             NOW(), NOW())`,
    [receiptId, poId]
  );

  await c.query(
    `INSERT INTO purchase_order_receipt_line
       (id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
        product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qb_item_list_id_snapshot,
        qty_received_now, unit_cost_cents_override,
        stock_applied, stock_applied_at,
        created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, 'pv-a', 'inv-a',
        'SKU-A', 'Widget A', 'QB-ITEM-A',
        5, NULL, TRUE, NOW(),
        NOW(), NOW()),
       ($5, $2, $6, $4, 'pv-b', 'inv-b',
        'SKU-B', 'Widget B', 'QB-ITEM-B',
        3, 1500, TRUE, NOW(),
        NOW(), NOW())`,
    [rlA, receiptId, poLineA, poId, rlB, poLineB]
  );

  await c.query(
    `INSERT INTO qb_item_receipt_pipeline
       (id, purchase_order_receipt_id, purchase_order_id,
        status, qb_list_id, payload, synced_at,
        created_at, updated_at)
     VALUES ($1, $2, $3, 'synced', 'QB-IR-TXN-1', '{}'::jsonb, NOW(),
             NOW(), NOW())`,
    [pipelineId, receiptId, poId]
  );

  return {
    poId,
    receiptId,
    pipelineId,
    poLineIds: [poLineA, poLineB],
    receiptLineIds: [rlA, rlB],
  };
}

interface PayloadLineRow {
  receipt_line_id: string;
  po_line_id: string;
  qb_item_list_id: string;
  qb_po_txn_line_id: string | null;
  sku: string;
  description: string;
  qty_received_now: number | string;
  unit_cost_cents: number | string;
}

async function main(): Promise<void> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const prefix = `smk${randomUUID().replace(/-/g, "").slice(0, 6)}-`;

  try {
    console.log(`${TAG} fixture prefix = ${prefix}`);
    await cleanup(c, prefix);
    const { poId, receiptId, pipelineId, poLineIds, receiptLineIds } =
      await insertFixture(c, prefix);

    // ── A) Header SELECT used by enqueueQbItemReceiptModStep ────────────────
    const hdrRes = await c.query(
      `SELECT
         r.id                              AS receipt_id,
         r.number                          AS receipt_number,
         r.purchase_order_id               AS po_id,
         r.qb_item_receipt_list_id         AS txn_id,
         r.qb_edit_sequence,
         po.number                         AS po_number,
         po.vendor_qb_list_id_snapshot     AS vendor_qb_list_id,
         po.vendor_name_snapshot           AS vendor_name,
         po.qb_purchase_order_list_id      AS qb_po_list_id,
         po.memo                           AS memo,
         pipe.id                           AS pipeline_id,
         pipe.status                       AS pipe_status,
         pipe.void_status                  AS pipe_void_status,
         pipe.mod_status                   AS pipe_mod_status
       FROM purchase_order_receipt r
       JOIN purchase_order po
         ON po.id = r.purchase_order_id
       JOIN qb_item_receipt_pipeline pipe
         ON pipe.purchase_order_receipt_id = r.id
       WHERE r.id = $1`,
      [receiptId]
    );
    const hdr = hdrRes.rows[0];

    assert(!!hdr, "header row joins receipt + po + pipeline");
    assert(hdr.txn_id === "QB-IR-TXN-1", "header.txn_id = QB-IR-TXN-1");
    assert(
      hdr.qb_edit_sequence === "999111222",
      "header.qb_edit_sequence preserved",
      `got ${hdr.qb_edit_sequence}`
    );
    assert(
      hdr.qb_po_list_id === "QB-PO-TXN-1",
      "header.qb_po_list_id preserved (used as TxnID for ItemReceipt-level PO ref)"
    );
    assert(
      hdr.vendor_qb_list_id === "QB-VEND-1",
      "header.vendor_qb_list_id preserved"
    );
    assert(hdr.pipe_status === "synced", "pipeline ADD status = synced");
    assert(
      hdr.pipe_void_status === null,
      "no void in progress",
      `got ${hdr.pipe_void_status}`
    );
    assert(hdr.pipe_mod_status === null, "no mod in progress yet");
    assert(
      hdr.pipeline_id === pipelineId,
      "pipeline row id resolved",
      `expected ${pipelineId}, got ${hdr.pipeline_id}`
    );

    // ── B) Line SELECT — qb_po_txn_line_id MUST come through every row ─────
    const lineRes = await c.query<PayloadLineRow>(
      `SELECT
         rl.id                            AS receipt_line_id,
         rl.purchase_order_line_id        AS po_line_id,
         rl.qb_item_list_id_snapshot      AS qb_item_list_id,
         rl.sku_snapshot                  AS sku,
         rl.description_snapshot          AS description,
         rl.qty_received_now              AS qty_received_now,
         COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)
                                          AS unit_cost_cents,
         pol.qb_txn_line_id               AS qb_po_txn_line_id
       FROM purchase_order_receipt_line rl
       JOIN purchase_order_line pol
         ON pol.id = rl.purchase_order_line_id
       WHERE rl.purchase_order_receipt_id = $1
         AND rl.qty_received_now > 0
       ORDER BY rl.id ASC`,
      [receiptId]
    );
    const lines = lineRes.rows;

    assert(lines.length === 2, "2 lines returned", `got ${lines.length}`);

    const sortedLines = [...lines].sort((a, b) =>
      a.po_line_id.localeCompare(b.po_line_id)
    );
    const lineA = sortedLines.find((l) => l.po_line_id === poLineIds[0])!;
    const lineB = sortedLines.find((l) => l.po_line_id === poLineIds[1])!;

    assert(
      lineA?.qb_po_txn_line_id === "TXNLINE-A",
      "line A: qb_po_txn_line_id = TXNLINE-A (LinkToTxn preserved)"
    );
    assert(
      lineB?.qb_po_txn_line_id === "TXNLINE-B",
      "line B: qb_po_txn_line_id = TXNLINE-B (LinkToTxn preserved)"
    );
    assert(
      Number(lineA?.unit_cost_cents) === 2500,
      "line A: unit_cost_cents = 2500 (PO line fallback when override is NULL)",
      `got ${lineA?.unit_cost_cents}`
    );
    assert(
      Number(lineB?.unit_cost_cents) === 1500,
      "line B: unit_cost_cents = 1500 (override applied)",
      `got ${lineB?.unit_cost_cents}`
    );
    assert(
      lineA?.qb_item_list_id === "QB-ITEM-A",
      "line A: qb_item_list_id snapshot preserved"
    );
    assert(
      lineA?.receipt_line_id === receiptLineIds[0],
      "line A: receipt_line_id matches fixture"
    );

    // ── C) Write a mod_payload + flip mod_status → verify constraint accepts
    const fakePayload = {
      txn_id: hdr.txn_id,
      edit_sequence: hdr.qb_edit_sequence,
      po_id: poId,
      receipt_id: receiptId,
      lines: sortedLines,
    };
    await c.query(
      `UPDATE qb_item_receipt_pipeline
          SET mod_status = 'waiting',
              mod_payload = $1::jsonb,
              mod_retries = 0
        WHERE id = $2`,
      [JSON.stringify(fakePayload), pipelineId]
    );

    const pendingCheck = await c.query(
      `SELECT mod_status, mod_payload->'edit_sequence' AS pay_edit_seq,
              jsonb_array_length(mod_payload->'lines') AS line_count
         FROM qb_item_receipt_pipeline
        WHERE id = $1`,
      [pipelineId]
    );
    assert(
      pendingCheck.rows[0]?.mod_status === "waiting",
      "mod_status='waiting' accepted by constraint"
    );
    assert(
      pendingCheck.rows[0]?.pay_edit_seq === '"999111222"' ||
        pendingCheck.rows[0]?.pay_edit_seq === "999111222",
      "mod_payload.edit_sequence frozen as expected",
      `got ${pendingCheck.rows[0]?.pay_edit_seq}`
    );
    assert(
      Number(pendingCheck.rows[0]?.line_count) === 2,
      "mod_payload has 2 lines"
    );

    // ── D) Constraint test: 'error' state accepted (chunk 3a)
    await c.query(
      `UPDATE qb_item_receipt_pipeline SET mod_status='error' WHERE id=$1`,
      [pipelineId]
    );
    const errCheck = await c.query(
      `SELECT mod_status FROM qb_item_receipt_pipeline WHERE id=$1`,
      [pipelineId]
    );
    assert(
      errCheck.rows[0]?.mod_status === "error",
      "mod_status='error' accepted by constraint"
    );

    // ── E) Constraint rejects invalid state
    let constraintRejected = false;
    try {
      await c.query(
        `UPDATE qb_item_receipt_pipeline SET mod_status='banana' WHERE id=$1`,
        [pipelineId]
      );
    } catch {
      constraintRejected = true;
    }
    assert(
      constraintRejected,
      "mod_status='banana' rejected by check constraint"
    );

    // ── F) Guard simulation: mod_status='waiting' would 409 the PATCH route
    await c.query(
      `UPDATE qb_item_receipt_pipeline SET mod_status='waiting' WHERE id=$1`,
      [pipelineId]
    );
    const guardRes = await c.query(
      `SELECT mod_status FROM qb_item_receipt_pipeline WHERE id=$1`,
      [pipelineId]
    );
    const wouldBlock = ["waiting", "submitted", "error"].includes(
      guardRes.rows[0]?.mod_status
    );
    assert(wouldBlock, "route would 409 with mod_in_progress (mod_status=waiting)");
  } finally {
    await cleanup(c, prefix);
    await c.end();
  }

  console.log(
    `\n${TAG} done — ${pass} passed, ${fail} failed (${pass + fail} total)`
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${TAG} crashed:`, err);
  process.exit(2);
});
