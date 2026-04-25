/**
 * scripts/fix/purge-purchase-orders.ts
 *
 * Deletes test/fake Purchase Order records and reverses any inventory
 * that was applied during receipt processing.
 *
 * Filters (pick one):
 *   PURGE_ALL=true      — delete every PO in the system
 *   PURGE_ID=po_01xxx   — delete one specific PO by ID
 *   PURGE_STATUS=draft  — delete all POs with a given status
 *
 * Options:
 *   DRY_RUN=true        — print what would be deleted, make no changes
 *
 * Examples:
 *   DRY_RUN=true PURGE_ALL=true yarn ts-node src/scripts/fix/purge-purchase-orders.ts
 *   PURGE_STATUS=draft  yarn ts-node src/scripts/fix/purge-purchase-orders.ts
 *   PURGE_ID=po_01xxx   yarn ts-node src/scripts/fix/purge-purchase-orders.ts
 *   PURGE_ALL=true      yarn ts-node src/scripts/fix/purge-purchase-orders.ts
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";
import * as readline from "readline";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const DRY_RUN = process.env.DRY_RUN === "true";
const PURGE_ALL = process.env.PURGE_ALL === "true";
const PURGE_ID = process.env.PURGE_ID?.trim();
const PURGE_STATUS = process.env.PURGE_STATUS?.trim();

interface PoRow {
  id: string;
  number: string;
  status: string;
  po_status: string;
  vendor_name_snapshot: string;
  created_at: string;
}

interface StockedLineRow {
  inventory_item_id: string;
  qty_received_now: number;
  receipt_location_id: string;
  receipt_number: string;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  if (!PURGE_ALL && !PURGE_ID && !PURGE_STATUS) {
    console.error(
      "❌  Must set one of: PURGE_ALL=true | PURGE_ID=<id> | PURGE_STATUS=<status>"
    );
    process.exit(1);
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // ── 1. Find target POs ──────────────────────────────────────────────────
    let where = "deleted_at IS NULL";
    const params: string[] = [];

    if (PURGE_ID) {
      params.push(PURGE_ID);
      where += ` AND id = $${params.length}`;
    } else if (PURGE_STATUS) {
      params.push(PURGE_STATUS);
      where += ` AND status = $${params.length}`;
    }

    const { rows: pos } = await db.query<PoRow>(
      `SELECT id, number, status, po_status, vendor_name_snapshot, created_at
       FROM purchase_order WHERE ${where} ORDER BY created_at`,
      params
    );

    if (pos.length === 0) {
      console.log("ℹ️  No purchase orders found matching criteria.");
      return;
    }

    console.log(`\n📋  ${DRY_RUN ? "[DRY RUN] " : ""}Found ${pos.length} PO(s):\n`);
    for (const po of pos) {
      const vendor = po.vendor_name_snapshot || "(no vendor)";
      const date = new Date(po.created_at).toLocaleDateString("en-US");
      console.log(
        `  ${po.number || po.id}  status=${po.status}/${po.po_status}  vendor=${vendor}  created=${date}`
      );
    }

    // ── 2. Preview applied inventory ────────────────────────────────────────
    const poIds = pos.map((p) => p.id);

    const { rows: stockedLines } = await db.query<StockedLineRow>(
      `SELECT
         porl.inventory_item_id,
         porl.qty_received_now,
         por.stock_location_id AS receipt_location_id,
         por.number            AS receipt_number
       FROM purchase_order_receipt_line porl
       JOIN purchase_order_receipt por
         ON por.id = porl.purchase_order_receipt_id
       WHERE porl.purchase_order_id = ANY($1::text[])
         AND porl.stock_applied  = true
         AND porl.qty_received_now > 0
         AND porl.deleted_at   IS NULL
         AND por.deleted_at    IS NULL`,
      [poIds]
    );

    if (stockedLines.length > 0) {
      console.log(
        `\n📦  ${stockedLines.length} receipt line(s) have applied stock that will be reversed:`
      );
      for (const line of stockedLines) {
        console.log(
          `  ↩  receipt=${line.receipt_number}  item=${line.inventory_item_id}  qty=-${line.qty_received_now}  loc=${line.receipt_location_id}`
        );
      }
    } else {
      console.log("\n📦  No applied stock to reverse.");
    }

    if (DRY_RUN) {
      console.log("\n🔍  DRY RUN — no changes made.\n");
      return;
    }

    // ── 3. Confirm (safety gate) ─────────────────────────────────────────────
    const ok = await confirm(
      `\n⚠️  Delete ${pos.length} PO(s)${stockedLines.length > 0 ? ` and reverse ${stockedLines.length} inventory adjustment(s)` : ""}? (y/N) `
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }

    // ── 4. Reverse inventory ─────────────────────────────────────────────────
    if (stockedLines.length > 0) {
      console.log("\n↩  Reversing inventory...");
      for (const line of stockedLines) {
        await db.query(
          `UPDATE inventory_level
           SET
             stocked_quantity       = stocked_quantity - $1,
             raw_stocked_quantity   = jsonb_set(
               raw_stocked_quantity,
               '{value}',
               to_jsonb(((raw_stocked_quantity->>'value')::numeric - $1)::text)
             ),
             updated_at             = NOW()
           WHERE inventory_item_id = $2
             AND location_id       = $3`,
          [line.qty_received_now, line.inventory_item_id, line.receipt_location_id]
        );
        console.log(
          `   ✓  item=${line.inventory_item_id}  -${line.qty_received_now}u  loc=${line.receipt_location_id}`
        );
      }
    }

    // ── 5. Delete in dependency order ────────────────────────────────────────
    console.log("\n🗑  Deleting records...");

    const { rowCount: vblLines } = await db.query(
      `DELETE FROM vendor_bill_line
       WHERE vendor_bill_id IN (
         SELECT id FROM vendor_bill WHERE purchase_order_id = ANY($1::text[])
       )`,
      [poIds]
    );
    console.log(`   vendor_bill_line       : ${vblLines ?? 0} rows`);

    const { rowCount: vbills } = await db.query(
      `DELETE FROM vendor_bill WHERE purchase_order_id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   vendor_bill            : ${vbills ?? 0} rows`);

    const { rowCount: qbReceipts } = await db.query(
      `DELETE FROM qb_item_receipt_pipeline WHERE purchase_order_id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   qb_item_receipt_pipeline: ${qbReceipts ?? 0} rows`);

    const { rowCount: receiptLines } = await db.query(
      `DELETE FROM purchase_order_receipt_line WHERE purchase_order_id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   purchase_order_receipt_line: ${receiptLines ?? 0} rows`);

    const { rowCount: receipts } = await db.query(
      `DELETE FROM purchase_order_receipt WHERE purchase_order_id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   purchase_order_receipt : ${receipts ?? 0} rows`);

    const { rowCount: qbPos } = await db.query(
      `DELETE FROM qb_purchase_order_pipeline WHERE purchase_order_id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   qb_purchase_order_pipeline: ${qbPos ?? 0} rows`);

    const { rowCount: poLines } = await db.query(
      `DELETE FROM purchase_order_line WHERE purchase_order_id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   purchase_order_line    : ${poLines ?? 0} rows`);

    const { rowCount: poRows } = await db.query(
      `DELETE FROM purchase_order WHERE id = ANY($1::text[])`,
      [poIds]
    );
    console.log(`   purchase_order         : ${poRows ?? 0} rows`);

    console.log(`\n✅  Purged ${poIds.length} PO(s) successfully.\n`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
