/**
 * verify-so-mod-post-confirm.ts
 *
 * Regression guard for the "SalesOrderMod silently dropped after create confirmed"
 * bug (order 2450: a SKU swap edited after the SO create confirmed never reached
 * the QB Sales Order because writePipelineRow's QB_CREATE_STEPS guard no-op'd the
 * confirmed→pending reactivation).
 *
 * Invariant proven here, against a throwaway sales_order row:
 *   1. writePipelineRow({step:"sales_order", status:"pending"})  WITHOUT intent
 *      over a CONFIRMED row  → NO-OP (row stays 'confirmed'). Protects ADD from
 *      re-dispatch / duplicate QB doc.
 *   2. writePipelineRow({..., intent:"mod", qbTxnId})  over the SAME confirmed row
 *      → reactivates to 'pending' (the consolidator then runs MOD-first). This is
 *      what makes a post-confirm edit actually reach QB.
 *   3. writePipelineRow({..., intent:"mod"}) WITHOUT qbTxnId → throws (a MOD must
 *      know which doc to modify; never silently degrade to an ADD).
 *
 * Uses a synthetic order_id so it never touches real pipeline rows, and cleans up
 * after itself. Read-only against real data.
 *
 * Run: env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) npx tsx src/scripts/verify/verify-so-mod-post-confirm.ts
 */
import { getDbPool } from "../../api/utils/db-pool";
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";

const SYNTH_ORDER = `order_VERIFYSOMOD_${Date.now()}`;
const SYNTH_TXN = "9C9999-9999999999";

let failures = 0;
const ok = (label: string, cond: boolean) => {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
};

async function statusOf(pool: any): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT status FROM qb_order_pipeline WHERE order_id=$1 AND step='sales_order' ORDER BY created_at DESC LIMIT 1`,
    [SYNTH_ORDER]
  );
  return rows[0]?.status ?? null;
}

async function main() {
  const pool = getDbPool();
  try {
    // Seed a CONFIRMED sales_order create row (mimics a SO already synced to QB).
    const rowId = await writePipelineRow({
      orderId: SYNTH_ORDER,
      step: "sales_order",
      status: "pending",
      medusaRefNumber: "S-VERIFY",
    });
    await writePipelineRow({
      orderId: SYNTH_ORDER,
      step: "sales_order",
      status: "confirmed",
      qbTxnId: SYNTH_TXN,
    });
    ok("seed: row is 'confirmed'", (await statusOf(pool)) === "confirmed");
    console.log(`   (row ${rowId})`);

    // 1. ADD-intent (no intent) over confirmed → must stay confirmed (guard no-op).
    await writePipelineRow({
      orderId: SYNTH_ORDER,
      step: "sales_order",
      status: "pending",
    });
    ok(
      "1. pending WITHOUT intent over confirmed → stays 'confirmed' (ADD guard holds)",
      (await statusOf(pool)) === "confirmed"
    );

    // 2. MOD-intent over confirmed → must reactivate to pending.
    await writePipelineRow({
      orderId: SYNTH_ORDER,
      step: "sales_order",
      status: "pending",
      intent: "mod",
      qbTxnId: SYNTH_TXN,
    });
    ok(
      "2. pending WITH intent:'mod'+qbTxnId over confirmed → reactivates to 'pending'",
      (await statusOf(pool)) === "pending"
    );

    // Confirm qb_txn_id preserved through the reactivation (needed for the Mod).
    const { rows: txnRows } = await pool.query(
      `SELECT qb_txn_id FROM qb_order_pipeline WHERE order_id=$1 AND step='sales_order' ORDER BY created_at DESC LIMIT 1`,
      [SYNTH_ORDER]
    );
    ok(
      "2b. qb_txn_id preserved across reactivation",
      txnRows[0]?.qb_txn_id === SYNTH_TXN
    );

    // 3. MOD-intent WITHOUT qbTxnId → must throw.
    let threw = false;
    try {
      await writePipelineRow({
        orderId: SYNTH_ORDER,
        step: "sales_order",
        status: "pending",
        intent: "mod",
      });
    } catch {
      threw = true;
    }
    ok("3. intent:'mod' WITHOUT qbTxnId → throws", threw);
  } finally {
    await pool.query(`DELETE FROM qb_order_pipeline WHERE order_id=$1`, [
      SYNTH_ORDER,
    ]);
    console.log("   (cleaned up synthetic rows)");
  }

  console.log(
    failures === 0
      ? "\n✅ ALL PASSED — SO MOD post-confirm invariant holds"
      : `\n❌ ${failures} FAILURE(S)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(1);
});
