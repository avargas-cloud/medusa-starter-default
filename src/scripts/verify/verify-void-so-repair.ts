/**
 * verify-void-so-repair.ts
 *
 * Verifies the complete void-invoice → sales-order repair decision logic.
 * Two sections:
 *   A) SYNTHETIC — pure in-memory, no DB writes, no QB calls. Tests every
 *      combination of flags against the mirrored decision function.
 *   B) DB VALIDATION — read-only queries against production data to find real
 *      examples and confirm they'd be handled correctly.
 *
 * Run:
 *   npx ts-node -r tsconfig-paths/register src/scripts/verify/verify-void-so-repair.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { Pool } from "pg";
import {
  getSoTxnId,
  getEstimateTxnId,
  getLatestInvoiceTxnId,
} from "../../lib/quickbooks/qb-metadata-types";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─── Colours ─────────────────────────────────────────────────────────────────

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const D = "\x1b[2m";
const B = "\x1b[1m";
const X = "\x1b[0m";

// ─── Decision logic (mirrors post-edit-sync exactly) ─────────────────────────

interface OrderState {
  orderId: string;
  displayId: number | string;
  createdAt: Date;
  metadata: Record<string, any>;
  itemCount: number;
  hasActiveInvoice: boolean;    // confirmed invoice/SR in QB, not voided
  soNeedsRepair: boolean;       // pipeline 'waiting' OR ('skipped' + voided pos_invoice)
  customerQbListId?: string;    // fallback when order metadata lacks qb_list_id
}

type QbAction =
  | "update_so_estimate"   // has SO/Estimate TxnId + no active invoice + items → update
  | "skipped_invoiced"     // active invoice (SO closed) → skip
  | "skipped_too_new"      // needs SO but order < 1h → wait
  | "new_so_queued"        // needs SO + >= 1h + qb_list_id → create
  | "no_qb_customer"       // needs SO + >= 1h + NO qb_list_id (order or customer)
  | "no_so_to_update";     // nothing to do

const ONE_HOUR_MS = 60 * 60 * 1000;

function evaluateAction(state: OrderState): QbAction {
  const soTxnId      = getSoTxnId(state.metadata);
  const estimateTxnId = getEstimateTxnId(state.metadata);
  const invoiceTxnId  = getLatestInvoiceTxnId(state.metadata);
  const { hasActiveInvoice, soNeedsRepair } = state;

  // Branch 1: existing QB SO or Estimate + no active invoice + has items → update
  if ((soTxnId || estimateTxnId) && !hasActiveInvoice && state.itemCount > 0) {
    return "update_so_estimate";
  }

  // Branch 2: active invoice owns the QB document
  if (hasActiveInvoice) {
    return "skipped_invoiced";
  }

  // Branch 3: no SO/Estimate — check if we need to create one
  //   invoiceTxnId  → invoice was QB-synced and is now voided
  //   soNeedsRepair → void route flagged it (pipeline 'waiting' or 'skipped'+voided pos_invoice)
  if ((invoiceTxnId || soNeedsRepair) && state.itemCount > 0) {
    const ageMs = Date.now() - state.createdAt.getTime();
    if (ageMs < ONE_HOUR_MS) return "skipped_too_new";

    // qb_list_id from order metadata, with customer fallback
    const qbListId =
      (state.metadata?.qb_list_id as string | undefined) ||
      state.customerQbListId;
    return qbListId ? "new_so_queued" : "no_qb_customer";
  }

  return "no_so_to_update";
}

// ─── Synthetic test runner ────────────────────────────────────────────────────

interface SyntheticCase {
  name: string;
  state: OrderState;
  expected: QbAction;
}

const OLD = new Date(Date.now() - 2 * ONE_HOUR_MS);   // 2h ago → always old enough
const NEW = new Date(Date.now() - 10 * 60 * 1000);    // 10 min ago → too new

const META_WITH_SO = { qb_sales_order: { txn_id: "SO-111" }, qb_list_id: "QB-999" };
const META_WITH_EST = { qb_estimate: { txn_id: "EST-222" }, qb_list_id: "QB-999" };
const META_WITH_INV = { qb_invoice_txn_id: "INV-333", qb_list_id: "QB-999" };
const META_BARE_ID  = { qb_list_id: "QB-999" };
const META_EMPTY    = {};

function mkState(overrides: Partial<OrderState>): OrderState {
  return {
    orderId: "synthetic",
    displayId: "SYNTH",
    createdAt: OLD,
    metadata: META_EMPTY,
    itemCount: 2,
    hasActiveInvoice: false,
    soNeedsRepair: false,
    customerQbListId: undefined,
    ...overrides,
  };
}

const SYNTHETIC: SyntheticCase[] = [
  // ── A: SO/Estimate update path ──────────────────────────────────────────────
  {
    name: "A1 · SO TxnId + no active invoice + items  →  update_so_estimate",
    state: mkState({ metadata: META_WITH_SO }),
    expected: "update_so_estimate",
  },
  {
    name: "A2 · Estimate TxnId + no active invoice + items  →  update_so_estimate",
    state: mkState({ metadata: META_WITH_EST }),
    expected: "update_so_estimate",
  },
  {
    name: "A3 · SO TxnId + active invoice (SO closed)  →  skipped_invoiced",
    state: mkState({ metadata: META_WITH_SO, hasActiveInvoice: true }),
    expected: "skipped_invoiced",
  },
  {
    name: "A4 · SO TxnId + no items  →  no_so_to_update (edge: empty order)",
    state: mkState({ metadata: META_WITH_SO, itemCount: 0 }),
    expected: "no_so_to_update",
  },

  // ── B: Direct-to-invoice (no SO) with active invoice ────────────────────────
  {
    name: "B1 · No SO + active invoice  →  skipped_invoiced",
    state: mkState({ metadata: META_BARE_ID, hasActiveInvoice: true }),
    expected: "skipped_invoiced",
  },

  // ── C: Void with QB invoice TxnId in metadata ────────────────────────────────
  {
    name: "C1 · No SO + QB invoice voided + old order + qb_list_id  →  new_so_queued",
    state: mkState({ metadata: META_WITH_INV, soNeedsRepair: false }),
    expected: "new_so_queued",
  },
  {
    name: "C2 · No SO + QB invoice voided + NEW order  →  skipped_too_new",
    state: mkState({ metadata: META_WITH_INV, createdAt: NEW }),
    expected: "skipped_too_new",
  },
  {
    name: "C3 · No SO + QB invoice voided + old + NO qb_list_id  →  no_qb_customer",
    state: mkState({ metadata: { qb_invoice_txn_id: "INV-333" } }),
    expected: "no_qb_customer",
  },
  {
    name: "C4 · No SO + QB invoice voided + old + no order qb_list_id but HAS customer fallback  →  new_so_queued",
    state: mkState({ metadata: { qb_invoice_txn_id: "INV-333" }, customerQbListId: "QB-CUST" }),
    expected: "new_so_queued",
  },

  // ── D: Void WITHOUT QB invoice (POS-only invoice, never synced) ───────────────
  //       soNeedsRepair=true is what the void route / post-edit-sync sets.
  {
    name: "D1 · No SO + no QB invoice + soNeedsRepair (waiting pipeline) + old + qb_list_id  →  new_so_queued",
    state: mkState({ metadata: META_BARE_ID, soNeedsRepair: true }),
    expected: "new_so_queued",
  },
  {
    name: "D2 · No SO + no QB invoice + soNeedsRepair (skipped+voided) + old + qb_list_id  →  new_so_queued",
    state: mkState({ metadata: META_BARE_ID, soNeedsRepair: true }),
    expected: "new_so_queued",
  },
  {
    name: "D3 · No SO + no QB invoice + soNeedsRepair + NEW order  →  skipped_too_new",
    state: mkState({ metadata: META_BARE_ID, soNeedsRepair: true, createdAt: NEW }),
    expected: "skipped_too_new",
  },
  {
    name: "D4 · No SO + no QB invoice + soNeedsRepair + old + NO qb_list_id anywhere  →  no_qb_customer",
    state: mkState({ metadata: META_EMPTY, soNeedsRepair: true }),
    expected: "no_qb_customer",
  },
  {
    name: "D5 · No SO + no QB invoice + soNeedsRepair + old + no order qb_list_id + HAS customer fallback  →  new_so_queued",
    state: mkState({ metadata: META_EMPTY, soNeedsRepair: true, customerQbListId: "QB-CUST" }),
    expected: "new_so_queued",
  },

  // ── E: No action needed ──────────────────────────────────────────────────────
  {
    name: "E1 · No SO + no invoice + no repair flag  →  no_so_to_update",
    state: mkState({ metadata: META_EMPTY }),
    expected: "no_so_to_update",
  },
  {
    name: "E2 · No SO + no invoice + no repair + has qb_list_id  →  no_so_to_update",
    state: mkState({ metadata: META_BARE_ID }),
    expected: "no_so_to_update",
  },

  // ── F: Void route already handled >= 1h (pipeline now submitted, not waiting) ─
  //       In this case soNeedsRepair=false (no waiting/skipped row) — no duplicate.
  {
    name: "F1 · >= 1h order, void route created SO (pipeline=submitted → no waiting row), user saves  →  no_so_to_update",
    state: mkState({ metadata: META_BARE_ID, soNeedsRepair: false }),
    expected: "no_so_to_update",
  },

  // ── G: SO exists + invoice was voided (SO should be open again) ───────────────
  {
    name: "G1 · SO TxnId + invoice voided (hasActiveInvoice=false) + items  →  update_so_estimate",
    state: mkState({ metadata: { ...META_WITH_SO, qb_invoice_txn_id: "INV-444" } }),
    expected: "update_so_estimate",
  },
];

function runSyntheticTests(): { pass: number; fail: number } {
  console.log(`\n${B}${C}━━━  SECTION A: SYNTHETIC TESTS (no DB, no QB)  ━━━${X}\n`);
  let pass = 0;
  let fail = 0;

  for (const tc of SYNTHETIC) {
    const got = evaluateAction(tc.state);
    const ok = got === tc.expected;
    if (ok) {
      console.log(`  ${G}✅${X} ${tc.name}`);
      console.log(`     ${D}→ "${got}"${X}`);
      pass++;
    } else {
      console.log(`  ${R}❌${X} ${tc.name}`);
      console.log(`     ${R}got="${got}"  expected="${tc.expected}"${X}`);
      fail++;
    }
  }
  console.log();
  return { pass, fail };
}

// ─── DB validation helpers ────────────────────────────────────────────────────

async function getSoRepairFlag(orderId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM qb_order_pipeline
     WHERE order_id = $1 AND step = 'sales_order'
       AND (
         status = 'waiting'
         OR (
           status = 'skipped'
           AND EXISTS (
             SELECT 1 FROM pos_invoice pi
             WHERE pi.order_id = $1 AND pi.status = 'voided' AND pi.deleted_at IS NULL
           )
         )
       )
     LIMIT 1`,
    [orderId]
  );
  return rows.length > 0;
}

async function getActiveInvoiceStatus(orderId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM qb_order_pipeline p
     WHERE p.order_id = $1 AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
       AND NOT EXISTS (
         SELECT 1 FROM qb_order_pipeline v
         WHERE v.order_id = $1 AND v.step = 'void_invoice' AND v.status = 'confirmed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM pos_invoice pi
         WHERE pi.order_id = $1 AND pi.status = 'voided' AND pi.deleted_at IS NULL
       )
     LIMIT 1`,
    [orderId]
  );
  return rows.length > 0;
}

async function getCustomerQbListId(orderId: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `SELECT c.metadata->>'qb_list_id' AS qb_list_id
     FROM "order" o JOIN customer c ON c.id = o.customer_id
     WHERE o.id = $1`,
    [orderId]
  );
  return (rows[0]?.qb_list_id as string | null | undefined) ?? undefined;
}

interface DbCase {
  name: string;
  description: string;
  expected: QbAction;
  query: string;
}

const DB_CASES: DbCase[] = [
  {
    name: "DB-1 · QB SO confirmed + no active invoice",
    description: "Normal order with SO in QB, not invoiced → should update SO",
    expected: "update_so_estimate",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL AND o.sales_channel_id = $1
        AND (o.metadata->>'qb_sales_order_txn_id' IS NOT NULL
             OR o.metadata->'qb_sales_order'->>'txn_id' IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM qb_order_pipeline v WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed')
            AND NOT EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status = 'voided' AND pi.deleted_at IS NULL)
        )
      ORDER BY o.created_at DESC LIMIT 3`,
  },
  {
    name: "DB-2 · QB SO + active invoice (SO closed by invoice)",
    description: "Order invoiced in QB → SO is closed, skip",
    expected: "skipped_invoiced",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL AND o.sales_channel_id = $1
        AND (o.metadata->>'qb_sales_order_txn_id' IS NOT NULL
             OR o.metadata->'qb_sales_order'->>'txn_id' IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM qb_order_pipeline v WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed')
            AND NOT EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status = 'voided' AND pi.deleted_at IS NULL)
        )
      ORDER BY o.created_at DESC LIMIT 3`,
  },
  {
    name: "DB-3 · No SO + voided POS invoice (pipeline skipped/waiting) + old order",
    description: "The S10096 scenario: direct-to-invoice, invoice voided, soNeedsRepair → create SO",
    expected: "new_so_queued",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id') IS NULL
        AND o.metadata->>'qb_estimate_txn_id' IS NULL
        AND o.created_at <= NOW() - INTERVAL '1 hour'
        AND EXISTS (
          SELECT 1 FROM pos_invoice pi
          WHERE pi.order_id = o.id AND pi.status = 'voided' AND pi.deleted_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline qp
          WHERE qp.order_id = o.id AND qp.step = 'sales_order'
            AND qp.status IN ('skipped', 'waiting')
        )
      ORDER BY o.created_at DESC LIMIT 3`,
  },
  {
    name: "DB-4 · No SO + active POS invoice (not voided) + old order",
    description: "Direct-to-invoice, invoice still active → skip (invoiced)",
    expected: "skipped_invoiced",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id') IS NULL
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM qb_order_pipeline v WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed')
            AND NOT EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status = 'voided' AND pi.deleted_at IS NULL)
        )
      ORDER BY o.created_at DESC LIMIT 3`,
  },
  {
    name: "DB-5 · No SO + voided invoice (QB void confirmed) + old + qb_list_id",
    description: "Invoice voided in QB (has qb_invoice_txn_id) → create SO",
    expected: "new_so_queued",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id') IS NULL
        AND o.created_at <= NOW() - INTERVAL '1 hour'
        AND o.metadata->>'qb_list_id' IS NOT NULL
        AND (o.metadata->>'qb_invoice_txn_id' IS NOT NULL
             OR jsonb_array_length(COALESCE(o.metadata->'qb_invoices','[]'::jsonb)) > 0)
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline v
          WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
        )
      ORDER BY o.created_at DESC LIMIT 3`,
  },
  {
    name: "DB-6 · Estimate TxnId + no active invoice",
    description: "Draft converted to order in QB → update Estimate",
    expected: "update_so_estimate",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL AND o.sales_channel_id = $1
        AND (o.metadata->>'qb_estimate_txn_id' IS NOT NULL
             OR o.metadata->'qb_estimate'->>'txn_id' IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM qb_order_pipeline v WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed')
            AND NOT EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status = 'voided' AND pi.deleted_at IS NULL)
        )
      ORDER BY o.created_at DESC LIMIT 2`,
  },
];

async function runDbValidation(posChannelId: string): Promise<{ pass: number; fail: number; nodata: number }> {
  console.log(`${B}${C}━━━  SECTION B: DB VALIDATION (read-only)  ━━━${X}\n`);
  let pass = 0; let fail = 0; let nodata = 0;

  for (const tc of DB_CASES) {
    console.log(`${C}▶ ${tc.name}${X}`);
    console.log(`  ${D}${tc.description}${X}`);

    const { rows } = await pool.query(tc.query, [posChannelId]);

    if (rows.length === 0) {
      console.log(`  ${Y}⚠  No matching orders in DB — case may not exist yet${X}\n`);
      nodata++;
      continue;
    }

    let caseOk = true;
    for (const row of rows) {
      const hasActiveInvoice = await getActiveInvoiceStatus(row.id);
      const soNeedsRepair    = await getSoRepairFlag(row.id);
      const customerQbListId = await getCustomerQbListId(row.id);
      const state: OrderState = {
        orderId: row.id,
        displayId: row.display_id,
        createdAt: new Date(row.created_at),
        metadata: row.metadata || {},
        itemCount: parseInt(row.item_count ?? "1", 10),
        hasActiveInvoice,
        soNeedsRepair,
        customerQbListId,
      };

      const got  = evaluateAction(state);
      const ok   = got === tc.expected;
      const ageM = Math.round((Date.now() - state.createdAt.getTime()) / 60000);
      const soId = getSoTxnId(state.metadata);
      const estId = getEstimateTxnId(state.metadata);
      const invId = getLatestInvoiceTxnId(state.metadata);

      const icon = ok ? `${G}✅` : `${R}❌`;
      console.log(
        `  ${icon} S${state.displayId}${X}  ` +
        `${D}age=${ageM}m | items=${state.itemCount}` +
        ` | SO=${soId ? "✓" : "—"} | Est=${estId ? "✓" : "—"}` +
        ` | invTxn=${invId ? "✓" : "—"} | activeInv=${hasActiveInvoice}` +
        ` | soRepair=${soNeedsRepair} | qbList=${state.metadata.qb_list_id || customerQbListId || "—"}${X}`
      );
      if (ok) {
        console.log(`     ${G}→ "${got}" ✓${X}`);
        pass++;
      } else {
        console.log(`     ${R}→ "${got}"  expected="${tc.expected}"${X}`);
        fail++;
        caseOk = false;
      }
    }
    console.log(caseOk
      ? `  ${G}All samples passed.${X}\n`
      : `  ${R}MISMATCH — review above.${X}\n`
    );
  }
  return { pass, fail, nodata };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const POS_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID;
  if (!POS_CHANNEL_ID) {
    console.error(`${R}❌ POS_SALES_CHANNEL_ID not set in .env${X}`);
    process.exit(1);
  }

  console.log(`\n${B}${C}╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║     Void Invoice → Sales Order Repair — Full Verification     ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝${X}\n`);

  // Section A: synthetic
  const syn = runSyntheticTests();

  // Section B: real DB (read-only)
  const db = await runDbValidation(POS_CHANNEL_ID);

  // ─── Summary ───────────────────────────────────────────────────────────────
  const totalPass = syn.pass + db.pass;
  const totalFail = syn.fail + db.fail;

  console.log(`${B}${C}━━━  SUMMARY  ━━━${X}`);
  console.log(`  Synthetic : ${G}${syn.pass} passed${X}  ${R}${syn.fail} failed${X}`);
  console.log(`  DB        : ${G}${db.pass} passed${X}  ${R}${db.fail} failed${X}  ${Y}${db.nodata} no data${X}`);
  console.log(`  Total     : ${G}${totalPass} passed${X}  ${R}${totalFail} failed${X}\n`);

  if (totalFail === 0) {
    console.log(`${G}${B}✅  All tests passed.${X}\n`);
  } else {
    console.log(`${R}${B}❌  Failures detected — review above.${X}\n`);
    process.exit(1);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(`${R}Fatal:${X}`, err);
  process.exit(1);
});
