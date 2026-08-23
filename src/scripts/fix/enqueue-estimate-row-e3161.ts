/**
 * enqueue-estimate-row-e3161.ts
 *
 * One-off remediation (2026-08-22): E3161 (order_01M0J8JZZ95QW86FXV0K7QEY12)
 * was born as S11548 and reverted to draft. The revert-to-draft route skipped
 * the sales_order pipeline row but never enqueued the estimate row, and the
 * qb-pos-sync cron only wakes existing 'waiting' rows — so the estimate never
 * reached QuickBooks. This inserts the missing 'pending' row via the canonical
 * writer; the consolidator's pending-dispatch pass picks it up next tick.
 *
 * Verified before running: no step='estimate' row exists for this order, and
 * metadata.qb_estimate_txn_id is null (no QB doc — an ADD cannot duplicate).
 *
 * Run (from backend/):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/fix/enqueue-estimate-row-e3161.ts
 */
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";
import { getDbPool } from "../../api/utils/db-pool";

const ORDER_ID = "order_01M0J8JZZ95QW86FXV0K7QEY12";
const REF = "E3161";

async function main() {
  const pool = getDbPool();

  // Guard: refuse if an estimate row already exists (idempotence) or if the
  // draft already has a QB TxnID (nothing to do).
  const { rows: existing } = await pool.query(
    `SELECT id, status FROM qb_order_pipeline WHERE order_id = $1 AND step = 'estimate'`,
    [ORDER_ID]
  );
  if (existing.length > 0) {
    console.log(
      `ABORT: estimate row already exists for ${REF}:`,
      existing.map((r) => `${r.id} (${r.status})`).join(", ")
    );
    process.exit(1);
  }

  const { rows: ord } = await pool.query(
    `SELECT is_draft_order, canceled_at, metadata->>'qb_estimate_txn_id' AS txn
       FROM "order" WHERE id = $1`,
    [ORDER_ID]
  );
  if (!ord[0]) {
    console.log(`ABORT: order ${ORDER_ID} not found`);
    process.exit(1);
  }
  if (!ord[0].is_draft_order || ord[0].canceled_at || ord[0].txn) {
    console.log(
      `ABORT: order state changed — is_draft=${ord[0].is_draft_order} canceled_at=${ord[0].canceled_at} qb_estimate_txn_id=${ord[0].txn}`
    );
    process.exit(1);
  }

  const rowId = await writePipelineRow({
    orderId: ORDER_ID,
    step: "estimate",
    status: "pending",
    medusaRefNumber: REF,
  });
  console.log(`OK: enqueued pending estimate row ${rowId} for ${REF}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
