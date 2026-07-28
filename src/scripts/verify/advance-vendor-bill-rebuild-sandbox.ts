/**
 * Advances one already-queued Vendor Bill rebuild with synthetic successful QB
 * responses. Sandbox-only test helper; never contacts the bridge.
 *
 * Usage:
 *   tsx src/scripts/verify/advance-vendor-bill-rebuild-sandbox.ts \
 *     <preflight-qop-id> <delete-qop-id>
 */

import { getDbPool } from "../../api/utils/db-pool";
import { confirmPipelineRow } from "../../lib/quickbooks/qb-pipeline";
import type { ResubmitRow } from "../../lib/quickbooks/consolidator/resubmit-by-step";
import {
  completeVendorBillRebuildDelete,
  completeVendorBillRebuildPreflight,
} from "../../lib/quickbooks/consolidator/vendor-bill-rebuild-operations";

const connectionString = process.env.DATABASE_URL ?? "";
if (!/localhost:5499|127\.0\.0\.1:5499/.test(connectionString)) {
  throw new Error(
    "Refusing to run: advance-vendor-bill-rebuild-sandbox is sandbox-only"
  );
}

const [preflightId, deleteId] = process.argv.slice(2);
if (!preflightId || !deleteId) {
  throw new Error("Both preflight and delete qb_order_pipeline IDs are required");
}

function asRow(raw: Record<string, unknown>): ResubmitRow {
  return {
    id: String(raw.id),
    order_id: raw.order_id ? String(raw.order_id) : null,
    reference_id: raw.reference_id ? String(raw.reference_id) : null,
    reference_type: raw.reference_type
      ? String(raw.reference_type)
      : null,
    step: String(raw.step),
    qb_txn_id: raw.qb_txn_id ? String(raw.qb_txn_id) : null,
    retry_count: Number(raw.retry_count ?? 0),
    payload: (raw.payload as Record<string, unknown> | null) ?? null,
  };
}

async function main(): Promise<void> {
  const pool = getDbPool();
  const result = await pool.query(
    `SELECT id, order_id, reference_id, reference_type, step, qb_txn_id,
            retry_count, payload
       FROM qb_order_pipeline
      WHERE id = ANY($1::uuid[])
      ORDER BY created_at, id`,
    [[preflightId, deleteId]]
  );
  const byId = new Map(
    result.rows.map((raw) => [String(raw.id), asRow(raw)])
  );
  const preflight = byId.get(preflightId);
  const deletion = byId.get(deleteId);
  if (
    preflight?.step !== "vendor_bill_rebuild_preflight" ||
    deletion?.step !== "vendor_bill_rebuild_delete"
  ) {
    throw new Error("The supplied rows are not a rebuild preflight/delete pair");
  }
  const txnId =
    preflight.qb_txn_id ??
    (typeof preflight.payload?.txn_id === "string"
      ? preflight.payload.txn_id
      : null);
  if (!txnId) throw new Error("Preflight row has no QB TxnID");

  const preflightOperation = {
    result: {
      QBXML: {
        QBXMLMsgsRs: {
          BillQueryRs: {
            statusCode: "0",
            BillRet: {
              TxnID: txnId,
              EditSequence: "SANDBOX-EDIT-SEQUENCE",
              RefNumber: "SANDBOX-REBUILD",
              IsPaid: false,
              AmountDue: "1.00",
            },
          },
        },
      },
    },
  };
  await completeVendorBillRebuildPreflight(
    preflight,
    preflightOperation
  );
  await confirmPipelineRow(
    preflight.id,
    txnId,
    "SANDBOX-REBUILD",
    preflightOperation.result
  );
  await pool.query(
    `UPDATE qb_order_pipeline
        SET status = 'pending', error = NULL, updated_at = NOW()
      WHERE id = $1 AND depends_on = $2`,
    [deletion.id, preflight.id]
  );

  const deleteOperation = {
    result: {
      QBXML: {
        QBXMLMsgsRs: {
          TxnDelRs: {
            statusCode: "0",
            TxnDelType: "Bill",
            TxnID: txnId,
          },
        },
      },
    },
  };
  await completeVendorBillRebuildDelete(deletion, deleteOperation);
  await confirmPipelineRow(
    deletion.id,
    null,
    null,
    deleteOperation.result
  );

  const state = await pool.query(
    `SELECT vb.id, vb.status, vb.qb_txn_id,
            qvb.intent, qvb.status AS pipeline_status,
            qvb.rebuild_generation
       FROM vendor_bill vb
       JOIN qb_vendor_bill_pipeline qvb ON qvb.vendor_bill_id = vb.id
      WHERE vb.id = $1`,
    [deletion.reference_id]
  );
  console.log(JSON.stringify(state.rows[0] ?? null, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
