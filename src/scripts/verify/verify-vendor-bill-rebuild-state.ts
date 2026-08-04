/**
 * Sandbox integration verifier for the reviewed Vendor Bill rebuild.
 *
 * Covers:
 * - a BillQuery without payment evidence fails closed;
 * - unpaid BillQuery advances the local mirror to rebuild_deleting;
 * - confirmed TxnDel clears every QB identity and leaves a draft/rebuild_ready;
 * - replaying the same completed delete is idempotent;
 * - a paid Bill blocks permanently without clearing its QB identity.
 */

import { Client } from "pg";

import type { ResubmitRow } from "../../lib/quickbooks/consolidator/resubmit-by-step";
import {
  completeVendorBillRebuildDelete,
  completeVendorBillRebuildPreflight,
  PermanentPurchaseOperationError,
} from "../../lib/quickbooks/consolidator/vendor-bill-rebuild-operations";

const SANDBOX_DEFAULT_URL =
  "postgresql://postgres:sandbox@localhost:5499/medusa";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
    return;
  }
  failed += 1;
  console.log(
    `  ❌ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`
  );
}

function rowFor(
  billId: string,
  pipelineId: string,
  txnId: string,
  step: string
): ResubmitRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    order_id: `po_verify_${billId}`,
    reference_id: billId,
    reference_type: "vendor_bill",
    step,
    qb_txn_id: txnId,
    retry_count: 0,
    payload: {
      vendor_bill_id: billId,
      qb_vendor_bill_pipeline_id: pipelineId,
      txn_id: txnId,
    },
  };
}

function qbResult(
  responseName: "BillQueryRs" | "TxnDelRs",
  response: Record<string, unknown>
): Record<string, unknown> {
  return {
    result: {
      QBXML: {
        QBXMLMsgsRs: {
          [responseName]: response,
        },
      },
    },
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL || SANDBOX_DEFAULT_URL;
  if (!/localhost:5499|127\.0\.0\.1:5499/.test(connectionString)) {
    throw new Error(
      "Refusing to run: verify-vendor-bill-rebuild-state is sandbox-only"
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  const stamp = Date.now();
  const billId = `vb_verify_rebuild_${stamp}`;
  const pipelineId = `qbvbpipe_verify_rebuild_${stamp}`;
  const lineId = `vbl_verify_rebuild_${stamp}`;
  const txnId = `TXN-REBUILD-${stamp}`;
  const paidBillId = `vb_verify_rebuild_paid_${stamp}`;
  const paidPipelineId = `qbvbpipe_verify_rebuild_paid_${stamp}`;
  const paidTxnId = `TXN-REBUILD-PAID-${stamp}`;

  try {
    await client.query(
      `INSERT INTO vendor_bill
         (id, status, bill_type, purchase_order_id, qb_txn_id,
          qb_edit_sequence, qb_ref_number, qb_source, qb_clearing_lines)
       VALUES
         ($1, 'synced', 'regular', $2, $3, 'ES-1', 'REF-1', 'owned',
          '[{"kind":"freight","qb_txn_line_id":"QB-CLEARING-1"}]'::jsonb),
         ($4, 'synced', 'regular', $5, $6, 'ES-P', 'REF-P', 'owned', NULL)`,
      [
        billId,
        `po_verify_${billId}`,
        txnId,
        paidBillId,
        `po_verify_${paidBillId}`,
        paidTxnId,
      ]
    );
    await client.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, sku, description, qty,
          unit_cost_cents, qb_txn_line_id)
       VALUES ($1, $2, 'product', 'VERIFY-SKU', 'Verifier line', 1, 100, 'QB-LINE-1')`,
      [lineId, billId]
    );
    await client.query(
      `INSERT INTO qb_vendor_bill_pipeline
         (id, vendor_bill_id, purchase_order_id, status, intent, qb_txn_id,
          payload, rebuild_generation)
       VALUES
         ($1, $2, $3, 'waiting', 'rebuild_prepare', $4, '{}'::jsonb, 4),
         ($5, $6, $7, 'waiting', 'rebuild_prepare', $8, '{}'::jsonb, 0)`,
      [
        pipelineId,
        billId,
        `po_verify_${billId}`,
        txnId,
        paidPipelineId,
        paidBillId,
        `po_verify_${paidBillId}`,
        paidTxnId,
      ]
    );

    const preflightRow = rowFor(
      billId,
      pipelineId,
      txnId,
      "vendor_bill_rebuild_preflight"
    );
    console.log("\n=== Unknown payment state fails closed ===");
    let unknownBlocked = false;
    try {
      await completeVendorBillRebuildPreflight(
        preflightRow,
        qbResult("BillQueryRs", {
          statusCode: "0",
          BillRet: { TxnID: txnId },
        })
      );
    } catch (error) {
      unknownBlocked =
        error instanceof Error &&
        error.message.includes("safety could not be verified");
    }
    const unknownState = (
      await client.query(
        `SELECT intent, status
           FROM qb_vendor_bill_pipeline
          WHERE id = $1`,
        [pipelineId]
      )
    ).rows[0];
    assert(
      "missing IsPaid/AmountDue does not advance the destructive chain",
      unknownBlocked &&
        unknownState?.intent === "rebuild_prepare" &&
        unknownState?.status === "waiting",
      unknownState
    );

    console.log("\n=== Unpaid preflight ===");
    await completeVendorBillRebuildPreflight(
      preflightRow,
      qbResult("BillQueryRs", {
        statusCode: "0",
        BillRet: {
          TxnID: txnId,
          EditSequence: "ES-2",
          RefNumber: "REF-1",
          IsPaid: false,
          AmountDue: "123.45",
          // A Bill raised from a PO always links the PO itself. The fixture
          // carries it because the preflight now REQUIRES the LinkedTxn list
          // to be present: absent means "we could not check for payments", and
          // that must never clear a hard delete. (2026-08-04)
          LinkedTxn: [{ TxnID: "po-verify-1", TxnType: "PurchaseOrder" }],
        },
      })
    );
    const unpaidState = (
      await client.query(
        `SELECT vb.qb_is_paid, vb.qb_balance_remaining_cents,
                qvb.intent, qvb.status
           FROM vendor_bill vb
           JOIN qb_vendor_bill_pipeline qvb ON qvb.vendor_bill_id = vb.id
          WHERE vb.id = $1`,
        [billId]
      )
    ).rows[0];
    assert(
      "unpaid preflight advances to rebuild_deleting",
      unpaidState?.intent === "rebuild_deleting" &&
        unpaidState?.status === "waiting",
      unpaidState
    );
    assert(
      "payment snapshot is persisted",
      unpaidState?.qb_is_paid === false &&
        Number(unpaidState?.qb_balance_remaining_cents) === 12345,
      unpaidState
    );

    // The hole this preflight had until 2026-08-04. QuickBooks reports a
    // PARTIALLY paid bill as IsPaid=false, and `AmountDue` is the invoice
    // total, not the open balance — so the old check said "unpaid" and cleared
    // a bill with money applied to it for hard deletion. The evidence was
    // already arriving in LinkedTxn and simply was not read.
    console.log("\n=== Partially paid bill is refused ===");
    let partialBlocked = false;
    try {
      await completeVendorBillRebuildPreflight(
        preflightRow,
        qbResult("BillQueryRs", {
          statusCode: "0",
          BillRet: {
            TxnID: txnId,
            EditSequence: "ES-3",
            IsPaid: false,
            AmountDue: "123.45",
            LinkedTxn: [
              { TxnID: "po-verify-1", TxnType: "PurchaseOrder" },
              { TxnID: "pay-verify-1", TxnType: "BillPaymentCheck" },
            ],
          },
        })
      );
    } catch (error) {
      partialBlocked =
        error instanceof Error &&
        error.message.includes("payment transaction(s) are applied");
    }
    assert(
      "a bill with a payment link is refused even though QuickBooks calls it unpaid",
      partialBlocked,
      { partialBlocked }
    );

    // Put the row back where the rest of the script expects it.
    await client.query(
      `UPDATE qb_vendor_bill_pipeline
          SET intent = 'rebuild_deleting', status = 'waiting',
              last_error = NULL, updated_at = NOW()
        WHERE id = $1`,
      [pipelineId]
    );

    console.log("\n=== Confirmed delete + idempotent replay ===");
    const deleteRow = rowFor(
      billId,
      pipelineId,
      txnId,
      "vendor_bill_rebuild_delete"
    );
    const deleteOperation = qbResult("TxnDelRs", {
      statusCode: "0",
      TxnDelType: "Bill",
      TxnID: txnId,
    });
    await completeVendorBillRebuildDelete(deleteRow, deleteOperation);
    await completeVendorBillRebuildDelete(deleteRow, deleteOperation);
    const rebuiltState = (
      await client.query(
        `SELECT vb.status, vb.qb_txn_id, vb.qb_edit_sequence,
                vb.qb_clearing_lines,
                vbl.qb_txn_line_id, qvb.intent, qvb.status AS pipeline_status,
                qvb.rebuild_generation
           FROM vendor_bill vb
           JOIN vendor_bill_line vbl ON vbl.vendor_bill_id = vb.id
           JOIN qb_vendor_bill_pipeline qvb ON qvb.vendor_bill_id = vb.id
          WHERE vb.id = $1`,
        [billId]
      )
    ).rows[0];
    assert(
      "delete leaves a local draft in rebuild_ready",
      rebuiltState?.status === "draft" &&
        rebuiltState?.intent === "rebuild_ready" &&
        rebuiltState?.pipeline_status === "waiting",
      rebuiltState
    );
    assert(
      "header and line QB identities are cleared",
      rebuiltState?.qb_txn_id === null &&
        rebuiltState?.qb_edit_sequence === null &&
        rebuiltState?.qb_clearing_lines === null &&
        rebuiltState?.qb_txn_line_id === null,
      rebuiltState
    );
    assert(
      "replayed completion increments generation only once",
      Number(rebuiltState?.rebuild_generation) === 5,
      rebuiltState
    );

    console.log("\n=== Paid preflight ===");
    const paidRow = rowFor(
      paidBillId,
      paidPipelineId,
      paidTxnId,
      "vendor_bill_rebuild_preflight"
    );
    let paidBlocked = false;
    try {
      await completeVendorBillRebuildPreflight(
        paidRow,
        qbResult("BillQueryRs", {
          statusCode: "0",
          BillRet: {
            TxnID: paidTxnId,
            IsPaid: true,
            AmountDue: "0.00",
          },
        })
      );
    } catch (error) {
      paidBlocked = error instanceof PermanentPurchaseOperationError;
    }
    const paidState = (
      await client.query(
        `SELECT vb.qb_txn_id, qvb.intent, qvb.status
           FROM vendor_bill vb
           JOIN qb_vendor_bill_pipeline qvb ON qvb.vendor_bill_id = vb.id
          WHERE vb.id = $1`,
        [paidBillId]
      )
    ).rows[0];
    assert("paid Bill throws the permanent safety block", paidBlocked);
    assert(
      "paid Bill identity is preserved",
      paidState?.qb_txn_id === paidTxnId &&
        paidState?.intent === "rebuild_prepare" &&
        paidState?.status === "failed_permanent",
      paidState
    );

    console.log(
      `\n=== RESULT: ${passed} passed, ${failed} failed ===${
        failed ? " ❌" : " ✅"
      }\n`
    );
  } finally {
    await client.query(
      `DELETE FROM qb_vendor_bill_pipeline WHERE id = ANY($1::text[])`,
      [[pipelineId, paidPipelineId]]
    );
    await client.query(
      `DELETE FROM vendor_bill_line WHERE id = $1`,
      [lineId]
    );
    await client.query(
      `DELETE FROM vendor_bill WHERE id = ANY($1::text[])`,
      [[billId, paidBillId]]
    );
    await client.end();
  }

  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
