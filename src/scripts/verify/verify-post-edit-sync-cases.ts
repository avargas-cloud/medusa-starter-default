/**
 * verify-post-edit-sync-cases.ts
 *
 * Verifies that post-edit-sync would choose the correct QB action for every
 * possible order state. Queries real pipeline + order data to find examples
 * of each case, then evaluates the decision logic and reports pass/fail.
 *
 * Run: npx ts-node -r tsconfig-paths/register src/scripts/verify/verify-post-edit-sync-cases.ts
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

// ─── Decision logic (mirrors post-edit-sync exactly) ─────────────────────────

interface OrderState {
  orderId: string;
  displayId: number;
  createdAt: Date;
  metadata: Record<string, any>;
  itemCount: number;
  // from qb_order_pipeline
  hasActiveInvoice: boolean;
  hasConfirmedVoid: boolean;
}

type QbAction =
  | "update_so_estimate"   // has SO/Estimate TxnId, no active invoice → update
  | "skipped_invoiced"     // active invoice, SO closed → skip, set child_synced
  | "skipped_too_new"      // voided invoice but order < 1h old → skip
  | "new_so_queued"        // voided invoice, >= 1h old, has qb_list_id → create SO
  | "no_qb_customer"       // voided invoice, >= 1h old, no qb_list_id
  | "no_so_to_update"      // no SO/Estimate, no active or voided invoice
  | "skip_no_items";       // SO/Estimate exists but no items (edge case)

const ONE_HOUR_MS = 60 * 60 * 1000;

function evaluateAction(state: OrderState): QbAction {
  const soTxnId = getSoTxnId(state.metadata);
  const estimateTxnId = getEstimateTxnId(state.metadata);
  const invoiceTxnId = getLatestInvoiceTxnId(state.metadata);
  const hasActiveInvoice = state.hasActiveInvoice;

  // Branch 1: has SO/Estimate TxnId
  if (soTxnId || estimateTxnId) {
    if (hasActiveInvoice) {
      return "skipped_invoiced";
    }
    if (state.itemCount === 0) {
      return "skip_no_items";
    }
    return "update_so_estimate";
  }

  // Branch 2: no SO/Estimate
  if (invoiceTxnId && !hasActiveInvoice && state.itemCount > 0) {
    const ageMs = Date.now() - new Date(state.createdAt).getTime();
    if (ageMs < ONE_HOUR_MS) {
      return "skipped_too_new";
    }
    const qbListId = state.metadata?.qb_list_id as string | undefined;
    return qbListId ? "new_so_queued" : "no_qb_customer";
  }

  return "no_so_to_update";
}

// ─── Expected outcomes per case ───────────────────────────────────────────────

interface TestCase {
  name: string;
  description: string;
  query: string;
  expectedAction: QbAction;
}

const CASES: TestCase[] = [
  {
    name: "CASE-1: SO TxnId + no active invoice",
    description: "Regular order with a QB Sales Order, not yet invoiced → update SO",
    expectedAction: "update_so_estimate",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND (o.metadata->>'qb_sales_order_txn_id' IS NOT NULL
             OR o.metadata->'qb_sales_order'->>'txn_id' IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM qb_order_pipeline v
            WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
          )
        )
        AND (o.metadata->>'qb_skip' IS NULL OR o.metadata->>'qb_skip' != 'true')
      LIMIT 3
    `,
  },
  {
    name: "CASE-2: SO TxnId + active invoice (SO closed)",
    description: "Order with QB SO that was invoiced (invoice still active) → skip, set child_synced",
    expectedAction: "skipped_invoiced",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND (o.metadata->>'qb_sales_order_txn_id' IS NOT NULL
             OR o.metadata->'qb_sales_order'->>'txn_id' IS NOT NULL)
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM qb_order_pipeline v
            WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
          )
        )
      LIMIT 3
    `,
  },
  {
    name: "CASE-3: No SO + voided invoice + order >= 1h old + has qb_list_id",
    description: "Direct-to-invoice order, invoice voided, order is old → create new SO",
    expectedAction: "new_so_queued",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id' IS NULL)
        AND o.created_at <= NOW() - INTERVAL '1 hour'
        AND o.metadata->>'qb_list_id' IS NOT NULL
        AND (
          o.metadata->>'qb_invoice_txn_id' IS NOT NULL
          OR jsonb_array_length(COALESCE(o.metadata->'qb_invoices','[]'::jsonb)) > 0
        )
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline v
          WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM qb_order_pipeline vv
            WHERE vv.order_id = o.id AND vv.step = 'void_invoice' AND vv.status = 'confirmed'
          )
        )
      LIMIT 3
    `,
  },
  {
    name: "CASE-4: No SO + active invoice (direct-to-invoice, not voided)",
    description: "Order invoiced directly without SO, invoice still active → skip, set child_synced",
    expectedAction: "skipped_invoiced",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id' IS NULL)
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM qb_order_pipeline v
            WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
          )
        )
      LIMIT 3
    `,
  },
  {
    name: "CASE-5: Estimate TxnId + no active invoice",
    description: "Draft order converted (has Estimate in QB) → update Estimate",
    expectedAction: "update_so_estimate",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND (o.metadata->>'qb_estimate_txn_id' IS NOT NULL
             OR o.metadata->'qb_estimate'->>'txn_id' IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM qb_order_pipeline v
            WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
          )
        )
      LIMIT 3
    `,
  },
  {
    name: "CASE-6: No SO, no invoice at all (brand new order)",
    description: "Order with no QB documents yet → no_so_to_update (cron handles SO creation)",
    expectedAction: "no_so_to_update",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id' IS NULL)
        AND o.metadata->>'qb_estimate_txn_id' IS NULL
        AND (o.metadata->'qb_estimate'->>'txn_id' IS NULL)
        AND o.metadata->>'qb_invoice_txn_id' IS NULL
        AND (o.metadata->'qb_invoices' IS NULL OR jsonb_array_length(o.metadata->'qb_invoices') = 0)
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
        )
      LIMIT 3
    `,
  },
  {
    name: "CASE-7: No SO + voided invoice + order < 1h old",
    description: "Quick void scenario — order too new for SO creation → skipped_too_new",
    expectedAction: "skipped_too_new",
    query: `
      SELECT o.id, o.display_id, o.created_at, o.metadata,
             (SELECT COUNT(*) FROM order_item WHERE order_id = o.id AND deleted_at IS NULL) AS item_count
      FROM "order" o
      WHERE o.deleted_at IS NULL
        AND o.sales_channel_id = $1
        AND o.metadata->>'qb_sales_order_txn_id' IS NULL
        AND (o.metadata->'qb_sales_order'->>'txn_id' IS NULL)
        AND o.created_at >= NOW() - INTERVAL '1 hour'
        AND (
          o.metadata->>'qb_invoice_txn_id' IS NOT NULL
          OR jsonb_array_length(COALESCE(o.metadata->'qb_invoices','[]'::jsonb)) > 0
        )
        AND EXISTS (
          SELECT 1 FROM qb_order_pipeline v
          WHERE v.order_id = o.id AND v.step = 'void_invoice' AND v.status = 'confirmed'
        )
        AND NOT EXISTS (
          SELECT 1 FROM qb_order_pipeline p
          WHERE p.order_id = o.id AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM qb_order_pipeline vv
            WHERE vv.order_id = o.id AND vv.step = 'void_invoice' AND vv.status = 'confirmed'
          )
        )
      LIMIT 3
    `,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getActiveInvoiceStatus(
  orderId: string
): Promise<{ hasActiveInvoice: boolean; hasConfirmedVoid: boolean }> {
  const { rows } = await pool.query(
    `SELECT
       (EXISTS (
         SELECT 1 FROM qb_order_pipeline p
         WHERE p.order_id = $1 AND p.step IN ('invoice','sales_receipt') AND p.status = 'confirmed'
         AND NOT EXISTS (
           SELECT 1 FROM qb_order_pipeline v
           WHERE v.order_id = $1 AND v.step = 'void_invoice' AND v.status = 'confirmed'
         )
       )) AS has_active_invoice,
       (EXISTS (
         SELECT 1 FROM qb_order_pipeline v
         WHERE v.order_id = $1 AND v.step = 'void_invoice' AND v.status = 'confirmed'
       )) AS has_confirmed_void`,
    [orderId]
  );
  return {
    hasActiveInvoice: rows[0]?.has_active_invoice ?? false,
    hasConfirmedVoid: rows[0]?.has_confirmed_void ?? false,
  };
}

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const POS_CHANNEL_ID = process.env.NEXT_PUBLIC_SALES_CHANNEL_ID;
  if (!POS_CHANNEL_ID) {
    console.error(`${RED}❌ NEXT_PUBLIC_SALES_CHANNEL_ID not set in .env${RESET}`);
    process.exit(1);
  }

  console.log(`\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`   post-edit-sync Decision Logic — Case Verification`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n`);

  let totalPass = 0;
  let totalFail = 0;
  let totalNoData = 0;

  for (const tc of CASES) {
    console.log(`${CYAN}▶ ${tc.name}${RESET}`);
    console.log(`  ${DIM}${tc.description}${RESET}`);

    const { rows } = await pool.query(tc.query, [POS_CHANNEL_ID]);

    if (rows.length === 0) {
      console.log(`  ${YELLOW}⚠  No matching orders found in DB (case may not exist yet)${RESET}\n`);
      totalNoData++;
      continue;
    }

    let casePass = true;
    for (const row of rows) {
      const { hasActiveInvoice, hasConfirmedVoid } = await getActiveInvoiceStatus(row.id);
      const state: OrderState = {
        orderId: row.id,
        displayId: row.display_id,
        createdAt: new Date(row.created_at),
        metadata: row.metadata || {},
        itemCount: parseInt(row.item_count ?? "1", 10),
        hasActiveInvoice,
        hasConfirmedVoid,
      };

      const action = evaluateAction(state);
      const pass = action === tc.expectedAction;
      const ageMinutes = Math.round((Date.now() - state.createdAt.getTime()) / 60000);
      const soTxnId = getSoTxnId(state.metadata);
      const estimateTxnId = getEstimateTxnId(state.metadata);
      const invoiceTxnId = getLatestInvoiceTxnId(state.metadata);

      const statusIcon = pass ? `${GREEN}✅` : `${RED}❌`;
      console.log(
        `  ${statusIcon} S${state.displayId}${RESET}` +
        ` ${DIM}| age=${ageMinutes}m | items=${state.itemCount}` +
        ` | soTxnId=${soTxnId ? "✓" : "—"}` +
        ` | estimateTxnId=${estimateTxnId ? "✓" : "—"}` +
        ` | invoiceTxnId=${invoiceTxnId ? "✓" : "—"}` +
        ` | activeInvoice=${hasActiveInvoice}` +
        ` | voidConfirmed=${hasConfirmedVoid}` +
        ` | qbListId=${state.metadata.qb_list_id ? "✓" : "—"}${RESET}`
      );

      if (pass) {
        console.log(`     ${GREEN}→ action="${action}" ✓ (expected)${RESET}`);
        totalPass++;
      } else {
        console.log(`     ${RED}→ action="${action}" ✗  expected="${tc.expectedAction}"${RESET}`);
        totalFail++;
        casePass = false;
      }
    }

    if (casePass) {
      console.log(`  ${GREEN}All samples passed.${RESET}\n`);
    } else {
      console.log(`  ${RED}SOME SAMPLES FAILED — logic mismatch detected.${RESET}\n`);
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log(`${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}`);
  console.log(`Summary: ${GREEN}${totalPass} passed${RESET}  ${RED}${totalFail} failed${RESET}  ${YELLOW}${totalNoData} cases with no data${RESET}`);

  if (totalFail === 0) {
    console.log(`${GREEN}✅ All cases with data verified correctly.${RESET}\n`);
  } else {
    console.log(`${RED}❌ Logic mismatch detected — review failed cases above.${RESET}\n`);
    process.exit(1);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(`${RED}Fatal error:${RESET}`, err);
  process.exit(1);
});
