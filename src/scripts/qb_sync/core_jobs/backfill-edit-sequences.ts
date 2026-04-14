/**
 * backfill-edit-sequences.ts
 *
 * Fetches and caches missing EditSequences for ALL QB documents that support it:
 *
 *   ✅ Estimates       → order.metadata.qb_estimate.edit_sequence
 *   ✅ Sales Orders    → order.metadata.qb_sales_order.edit_sequence
 *   ✅ Invoices        → order.metadata.qb_invoices[*].edit_sequence  (bridge: GET /api/invoices)
 *   ✅ Sales Receipts  → order.metadata.qb_invoices[*].edit_sequence  (bridge: GET /api/sales-receipts)
 *   ✅ Payments        → order.metadata.qb_payments[*].edit_sequence  (bridge: GET /api/payments)
 *   ✅ Credit Memos    → qb_edit_sequence_cache only                   (bridge: GET /api/credit-memos)
 *   ✅ Write Checks    → qb_edit_sequence_cache only                   (bridge: GET /api/checks)
 *
 * Run: npx ts-node src/scripts/qb_sync/core_jobs/backfill-edit-sequences.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import {
  bridgeFetch,
  pollRawOperationResult,
} from "../../../lib/quickbooks/client/core";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type QbEndpoint =
  | "estimates"
  | "sales-orders"
  | "invoices"
  | "sales-receipts"
  | "payments"
  | "credit-memos"
  | "checks";

async function queryEditSequence(
  endpoint: QbEndpoint,
  txnId: string
): Promise<string | null> {
  try {
    const queryResp = await bridgeFetch("GET", `/api/${endpoint}/${txnId}`);
    const opId = queryResp?.operationId;
    if (!opId) throw new Error(`No operationId for ${endpoint}/${txnId}`);

    const raw = await pollRawOperationResult(opId);

    const editSeq =
      // Estimate
      raw?.QBXML?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet?.EditSequence ||
      raw?.QBXMLMsgsRs?.EstimateQueryRs?.EstimateRet?.EditSequence ||
      raw?.EstimateRet?.EditSequence ||
      // Sales Order
      raw?.QBXML?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet?.EditSequence ||
      raw?.QBXMLMsgsRs?.SalesOrderQueryRs?.SalesOrderRet?.EditSequence ||
      raw?.SalesOrderRet?.EditSequence ||
      // Invoice
      raw?.QBXML?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet?.EditSequence ||
      raw?.QBXMLMsgsRs?.InvoiceQueryRs?.InvoiceRet?.EditSequence ||
      raw?.InvoiceRet?.EditSequence ||
      // Sales Receipt
      raw?.QBXML?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet
        ?.EditSequence ||
      raw?.QBXMLMsgsRs?.SalesReceiptQueryRs?.SalesReceiptRet?.EditSequence ||
      raw?.SalesReceiptRet?.EditSequence ||
      // Receive Payment
      raw?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet
        ?.EditSequence ||
      raw?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet
        ?.EditSequence ||
      raw?.ReceivePaymentRet?.EditSequence ||
      // Credit Memo
      raw?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet?.EditSequence ||
      raw?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet?.EditSequence ||
      raw?.CreditMemoRet?.EditSequence ||
      // Check (Write Check)
      raw?.QBXML?.QBXMLMsgsRs?.CheckQueryRs?.CheckRet?.EditSequence ||
      raw?.QBXMLMsgsRs?.CheckQueryRs?.CheckRet?.EditSequence ||
      raw?.CheckRet?.EditSequence ||
      null;

    return editSeq ? String(editSeq) : null;
  } catch (err: any) {
    console.error(`  ❌ ${endpoint}/${txnId}: ${err.message}`);
    return null;
  }
}

async function upsertCache(entityType: string, qbId: string, editSeq: string) {
  await pool.query(
    `INSERT INTO qb_edit_sequence_cache (entity_type, qb_id, edit_seq, cached_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (entity_type, qb_id) DO UPDATE
             SET edit_seq = EXCLUDED.edit_seq, cached_at = NOW()`,
    [entityType, qbId, editSeq]
  );
}

async function main() {
  console.log("🔍 QB EditSequence Backfill\n");
  let fixed = 0,
    failed = 0;

  // ── 1. Estimates ──────────────────────────────────────────────────────────
  console.log("── Estimates ────────────────────────────────────────────────");
  const { rows: ests } = await pool.query(`
        SELECT id, metadata->'qb_estimate'->>'txn_id' AS txn_id
        FROM "order"
        WHERE metadata->'qb_estimate'->>'txn_id' IS NOT NULL
          AND (metadata->'qb_estimate'->>'edit_sequence' IS NULL
               OR metadata->'qb_estimate'->>'edit_sequence' = '')
        ORDER BY created_at DESC
    `);
  console.log(`${ests.length} missing\n`);

  for (const row of ests) {
    console.log(`  estimate ${row.txn_id}`);
    const seq = await queryEditSequence("estimates", row.txn_id);
    if (!seq) {
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    await pool.query(
      `UPDATE "order"
             SET metadata = jsonb_set(metadata, '{qb_estimate,edit_sequence}', to_jsonb($1::text))
             WHERE id = $2`,
      [seq, row.id]
    );
    await upsertCache("estimate", row.txn_id, seq);
    console.log(`  ✅ ${seq}`);
    fixed++;
    await sleep(DELAY_MS);
  }

  // ── 2. Sales Orders ───────────────────────────────────────────────────────
  console.log(
    "\n── Sales Orders ─────────────────────────────────────────────"
  );
  const { rows: sos } = await pool.query(`
        SELECT id, metadata->'qb_sales_order'->>'txn_id' AS txn_id
        FROM "order"
        WHERE metadata->'qb_sales_order'->>'txn_id' IS NOT NULL
          AND (metadata->'qb_sales_order'->>'edit_sequence' IS NULL
               OR metadata->'qb_sales_order'->>'edit_sequence' = '')
        ORDER BY created_at DESC
    `);
  console.log(`${sos.length} missing\n`);

  for (const row of sos) {
    console.log(`  sales_order ${row.txn_id}`);
    const seq = await queryEditSequence("sales-orders", row.txn_id);
    if (!seq) {
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    await pool.query(
      `UPDATE "order"
             SET metadata = jsonb_set(metadata, '{qb_sales_order,edit_sequence}', to_jsonb($1::text))
             WHERE id = $2`,
      [seq, row.id]
    );
    await upsertCache("sales_order", row.txn_id, seq);
    console.log(`  ✅ ${seq}`);
    fixed++;
    await sleep(DELAY_MS);
  }

  // ── 3. Invoices & Sales Receipts (both stored in qb_invoices[]) ──────────
  console.log(
    "\n── Invoices & Sales Receipts ─────────────────────────────────"
  );
  const { rows: invRows } = await pool.query(`
        SELECT
            o.id AS order_id,
            elem->>'txn_id'     AS txn_id,
            elem->>'invoice_id' AS invoice_id,
            (idx - 1)::int      AS idx
        FROM "order" o,
             jsonb_array_elements(o.metadata->'qb_invoices') WITH ORDINALITY arr(elem, idx)
        WHERE o.metadata->'qb_invoices' IS NOT NULL
          AND elem->>'txn_id' IS NOT NULL
          AND (elem->>'edit_sequence' IS NULL OR elem->>'edit_sequence' = '')
        ORDER BY o.created_at DESC
    `);
  console.log(`${invRows.length} missing\n`);

  for (const row of invRows) {
    let docType: "invoices" | "sales-receipts" = "invoices";
    let cacheType = "invoice";

    if (row.invoice_id) {
      try {
        const { rows: invMeta } = await pool.query(
          `SELECT metadata FROM pos_invoice WHERE id = $1 LIMIT 1`,
          [row.invoice_id]
        );
        const meta = invMeta[0]?.metadata || {};
        if (
          meta.is_sales_receipt === true ||
          meta.is_sales_receipt === "true" ||
          (meta.qb_ref_number && String(meta.qb_ref_number).startsWith("SR-"))
        ) {
          docType = "sales-receipts";
          cacheType = "sales_receipt";
        }
      } catch {
        /* fallback to invoice */
      }
    }

    console.log(`  ${docType} ${row.txn_id} (idx=${row.idx})`);
    const seq = await queryEditSequence(docType, row.txn_id);
    if (!seq) {
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    await pool.query(
      `UPDATE "order"
             SET metadata = jsonb_set(
                 metadata,
                 ARRAY['qb_invoices', $1::text, 'edit_sequence'],
                 to_jsonb($2::text)
             )
             WHERE id = $3`,
      [String(row.idx), seq, row.order_id]
    );
    await upsertCache(cacheType, row.txn_id, seq);
    console.log(`  ✅ ${seq}`);
    fixed++;
    await sleep(DELAY_MS);
  }

  // ── 4. Payments (stored in qb_payments[]) ────────────────────────────────
  console.log(
    "\n── Payments ─────────────────────────────────────────────────"
  );
  const { rows: payRows } = await pool.query(`
        SELECT
            o.id AS order_id,
            elem->>'txn_id' AS txn_id,
            (idx - 1)::int  AS idx
        FROM "order" o,
             jsonb_array_elements(o.metadata->'qb_payments') WITH ORDINALITY arr(elem, idx)
        WHERE o.metadata->'qb_payments' IS NOT NULL
          AND elem->>'txn_id' IS NOT NULL
          AND (elem->>'edit_sequence' IS NULL OR elem->>'edit_sequence' = '')
        ORDER BY o.created_at DESC
    `);
  console.log(`${payRows.length} missing\n`);

  for (const row of payRows) {
    console.log(`  payment ${row.txn_id} (idx=${row.idx})`);
    const seq = await queryEditSequence("payments", row.txn_id);
    if (!seq) {
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    await pool.query(
      `UPDATE "order"
             SET metadata = jsonb_set(
                 metadata,
                 ARRAY['qb_payments', $1::text, 'edit_sequence'],
                 to_jsonb($2::text)
             )
             WHERE id = $3`,
      [String(row.idx), seq, row.order_id]
    );
    await upsertCache("payment", row.txn_id, seq);
    console.log(`  ✅ ${seq}`);
    fixed++;
    await sleep(DELAY_MS);
  }

  // ── 5. Credit Memos (pipeline table → cache only) ─────────────────────────
  console.log(
    "\n── Credit Memos ─────────────────────────────────────────────"
  );
  const { rows: cmRows } = await pool.query(`
        SELECT DISTINCT p.qb_txn_id AS txn_id
        FROM qb_order_pipeline p
        LEFT JOIN qb_edit_sequence_cache c
            ON c.entity_type = 'credit_memo' AND c.qb_id = p.qb_txn_id
        WHERE p.step = 'credit_memo'
          AND p.status = 'confirmed'
          AND p.qb_txn_id IS NOT NULL
          AND (c.qb_id IS NULL OR c.edit_seq IS NULL)
        ORDER BY p.qb_txn_id
    `);
  console.log(`${cmRows.length} missing\n`);

  for (const row of cmRows) {
    console.log(`  credit_memo ${row.txn_id}`);
    const seq = await queryEditSequence("credit-memos", row.txn_id);
    if (!seq) {
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    await upsertCache("credit_memo", row.txn_id, seq);
    console.log(`  ✅ ${seq}`);
    fixed++;
    await sleep(DELAY_MS);
  }

  // ── 6. Write Checks (pipeline table → cache only) ─────────────────────────
  console.log(
    "\n── Write Checks ─────────────────────────────────────────────"
  );
  const { rows: checkRows } = await pool.query(`
        SELECT DISTINCT p.qb_txn_id AS txn_id
        FROM qb_order_pipeline p
        LEFT JOIN qb_edit_sequence_cache c
            ON c.entity_type = 'write_check' AND c.qb_id = p.qb_txn_id
        WHERE p.step = 'write_check'
          AND p.status = 'confirmed'
          AND p.qb_txn_id IS NOT NULL
          AND (c.qb_id IS NULL OR c.edit_seq IS NULL)
        ORDER BY p.qb_txn_id
    `);
  console.log(`${checkRows.length} missing\n`);

  for (const row of checkRows) {
    console.log(`  write_check ${row.txn_id}`);
    const seq = await queryEditSequence("checks", row.txn_id);
    if (!seq) {
      failed++;
      await sleep(DELAY_MS);
      continue;
    }

    await upsertCache("write_check", row.txn_id, seq);
    console.log(`  ✅ ${seq}`);
    fixed++;
    await sleep(DELAY_MS);
  }

  console.log(`\n${"─".repeat(55)}`);
  console.log(`✅ Fixed: ${fixed}  ❌ Failed: ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
