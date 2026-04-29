import { parse } from "dotenv";
import { readFileSync } from "fs";
import { Pool } from "pg";

const envConfig = parse(readFileSync(".env"));
const pool = new Pool({ connectionString: envConfig.DATABASE_URL });

// ── Constants ──────────────────────────────────────────────────────────────
const VEETECH_VENDOR_ID = "qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC";
const VEETECH_NAME = "VEETECH Co., Ltd";
const VEETECH_QB_LIST_ID = "800018B4-1621454061";
const STOCK_LOCATION_ID = "sloc_01KFS2AV3TAKR141KC2D6JCGTR"; // Ecopowertech Miami
const SPECIAL_ITEM_VARIANT_ID = "variant_01KK53MV8XGZBBX3ZEDZEBHV05";
const SPECIAL_ITEM_INVENTORY_ID = "iitem_01KK5EVQA817T89W1EJ9ECNJP7";
const SPECIAL_ITEM_QB_LIST_ID = "800003B1-1374009968";
const CREATED_BY_USER_ID = "user_01KFHEWY9YFW1CJ4YTHMJP945N"; // a.vargas

// ── QB POs from screenshot ─────────────────────────────────────────────────
// Col 2 = QB TxnNumber | Col 3 = QB TxnID (qb_purchase_order_list_id) | Col 4 = QB EditSequence
const QB_POS = [
  { txnNumber: "174250", txnId: "1C1C78-1777321785", editSeq: "1777406888" },
  { txnNumber: "174247", txnId: "1C1B73-1777165620", editSeq: "1777406064" },
  { txnNumber: "174243", txnId: "1C12AD-1776792239", editSeq: "1777386151" },
  { txnNumber: "174241", txnId: "1C1156-1776713606", editSeq: "1777382129" },
  { txnNumber: "174226", txnId: "1BFB92-1775595572", editSeq: "1776787119" },
];

// ── ID generator (Crockford base32 ULID-style) ─────────────────────────────
function genId(prefix: string): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = Date.now();
  let timeStr = "";
  for (let i = 9; i >= 0; i--) {
    timeStr = chars[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr += chars[Math.floor(Math.random() * 32)];
  }
  return `${prefix}_${timeStr}${randStr}`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // Verify current max seq before starting
  const check = await pool.query(
    "SELECT MAX(seq) AS max_seq, COUNT(*) AS total FROM purchase_order"
  );
  console.log(
    `Current POs: ${check.rows[0].total} | Max seq: ${check.rows[0].max_seq}`
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const qbPo of QB_POS) {
      // Advance the canonical PO sequence
      const seqRes = await client.query(
        "SELECT NEXTVAL('custom_purchase_order_seq') AS seq"
      );
      const seq = parseInt(seqRes.rows[0].seq, 10);
      const number = `PO-${seq}`;
      const poId = genId("po");
      const lineId = genId("pol");

      await client.query(
        `INSERT INTO purchase_order (
          id, number, seq, status,
          vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
          stock_location_id,
          subtotal_cents, tax_cents, shipping_cents, other_fees_cents, total_cents,
          currency_code,
          total_lines, total_units_ordered, total_units_received,
          qb_purchase_order_list_id, qb_purchase_order_txn_number,
          qb_edit_sequence, qb_synced_at,
          submitted_at, submitted_by_user_id,
          created_by_user_id,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'submitted',
          $4, $5, $6,
          $7,
          0, 0, 0, 0, 0,
          'usd',
          1, 1, 0,
          $8, $9,
          $10, NOW(),
          NOW(), $11,
          $11,
          NOW(), NOW()
        )`,
        [
          poId,
          number,
          seq,
          VEETECH_VENDOR_ID,
          VEETECH_NAME,
          VEETECH_QB_LIST_ID,
          STOCK_LOCATION_ID,
          qbPo.txnId,
          qbPo.txnNumber,
          qbPo.editSeq,
          CREATED_BY_USER_ID,
        ]
      );

      await client.query(
        `INSERT INTO purchase_order_line (
          id, purchase_order_id,
          product_variant_id, inventory_item_id,
          sku_snapshot, description_snapshot, qb_item_list_id_snapshot,
          qty_ordered, qty_received, qty_cancelled,
          unit_cost_cents, tax_cents, total_cents,
          status, line_order,
          created_at, updated_at
        ) VALUES (
          $1, $2,
          $3, $4,
          'Special Item', 'Special Item', $5,
          1, 0, 0,
          0, 0, 0,
          'open', 0,
          NOW(), NOW()
        )`,
        [
          lineId,
          poId,
          SPECIAL_ITEM_VARIANT_ID,
          SPECIAL_ITEM_INVENTORY_ID,
          SPECIAL_ITEM_QB_LIST_ID,
        ]
      );

      // QB pipeline row — status 'synced' = already created in QB (no ADD will be sent)
      // When the user saves edits via UI, a MOD row will be appended separately.
      const pipelineId = genId("qbpopipe");
      const pipelinePayload = {
        po_id: poId,
        po_number: number,
        vendor_name: VEETECH_NAME,
        vendor_qb_list_id: VEETECH_QB_LIST_ID,
        ordered_at: null,
        expected_at: null,
        memo: null,
        reference_number: null,
        lines: [
          {
            line_id: lineId,
            sku: "Special Item",
            description: "Special Item",
            qty_ordered: 1,
            qb_item_list_id: SPECIAL_ITEM_QB_LIST_ID,
            unit_cost_cents: 0,
          },
        ],
      };

      await client.query(
        `INSERT INTO qb_purchase_order_pipeline (
          id, purchase_order_id,
          status, qb_list_id, qb_txn_number,
          payload, synced_at,
          retries,
          created_at, updated_at
        ) VALUES (
          $1, $2,
          'synced', $3, $4,
          $5, NOW(),
          0,
          NOW(), NOW()
        )`,
        [
          pipelineId,
          poId,
          qbPo.txnId,
          qbPo.txnNumber,
          JSON.stringify(pipelinePayload),
        ]
      );

      console.log(
        `✓ ${number} (seq=${seq}) ← QB TxnID: ${qbPo.txnId} | TxnNumber: ${qbPo.txnNumber}`
      );
    }

    await client.query("COMMIT");
    console.log("\n✅ All 5 POs imported with synced pipeline rows.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Rolled back:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
