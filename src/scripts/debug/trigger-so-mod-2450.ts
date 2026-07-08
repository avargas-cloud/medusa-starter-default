/**
 * trigger-so-mod-2450.ts — one-off remediation trigger for order 2450.
 *
 * Enqueues a SalesOrderMod by reactivating the confirmed sales_order row to
 * 'pending' with intent:"mod" (exercises the QB_CREATE_STEPS guard fix). The
 * consolidator (dispatch-pass → resubmit-by-step case "sales_order") runs
 * MOD-first via handleOrderUpdated, which reads qb_sales_order.txn_id and issues
 * a SalesOrderMod — correcting the stale SUP-C2R4N70W10CT → BTF-C2R4N70W10CT.
 *
 * Run (prod DB from .env):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) npx tsx src/scripts/debug/trigger-so-mod-2450.ts
 */
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";
import { getDbPool } from "../../api/utils/db-pool";

const ORDER_ID = "order_01KW9YA3ARG7NSNB9DCXG9B9EY";
const SO_TXN = "1C92C9-1783346457";

async function main() {
  const pool = getDbPool();

  const { rows: before } = await pool.query(
    `SELECT status, qb_txn_id, to_char(updated_at,'MM-DD HH24:MI') upd
       FROM qb_order_pipeline WHERE order_id=$1 AND step='sales_order'
      ORDER BY created_at DESC LIMIT 1`,
    [ORDER_ID]
  );
  console.log("BEFORE sales_order row:", before[0]);

  const id = await writePipelineRow({
    orderId: ORDER_ID,
    step: "sales_order",
    status: "pending",
    intent: "mod",
    qbTxnId: SO_TXN,
  });
  console.log("writePipelineRow returned row id:", id);

  const { rows: after } = await pool.query(
    `SELECT status, qb_txn_id, to_char(updated_at,'MM-DD HH24:MI') upd
       FROM qb_order_pipeline WHERE order_id=$1 AND step='sales_order'
      ORDER BY created_at DESC LIMIT 1`,
    [ORDER_ID]
  );
  console.log("AFTER sales_order row:", after[0]);

  if (after[0]?.status === "pending") {
    console.log(
      "✅ Row reactivated to 'pending' — consolidator will dispatch SalesOrderMod next tick."
    );
  } else {
    console.log(
      `⚠️ Row is '${after[0]?.status}' (expected 'pending'). Guard may have no-op'd — check intent/qbTxnId.`
    );
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("trigger failed:", e);
  process.exit(1);
});
