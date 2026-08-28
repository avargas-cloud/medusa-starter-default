/**
 * verify-so-mod-post-confirm.ts
 *
 * Regression guard for "a post-confirm edit must still reach the QB Sales
 * Order" (order 2450: a SKU swap edited after the SO create confirmed never
 * arrived, because writePipelineRow's QB_CREATE_STEPS guard no-op'd it).
 *
 * ─── REWRITTEN 2026-08-27 — check 2 was asserting a RETIRED model ────────────
 *
 * Until today check 2 asserted that intent:"mod" REACTIVATES the ADD's row to
 * 'pending'. That was true in July and stopped being true on 2026-08-06, when
 * the append-only lane landed: writePipelineRow now REDIRECTS every sales mod
 * to enqueueSalesMutation, which inserts its own `sales_order_mod` row, and
 * the ADD's row keeps its confirm forever. row-mutations.ts:155 says it
 * outright — "a sales MOD never recycles the ADD's row anymore ... so the
 * reactivation branches below can never destroy an ADD's confirm again".
 *
 * So the check had its SIGN INVERTED: green would have meant the destructive
 * reactivation was back. It also never saw the new row — `statusOf` reads
 * step='sales_order', and the mod now lands on step='sales_order_mod'. That
 * same blind spot is why 2b ("qb_txn_id preserved across reactivation") passed
 * in a vacuum: with no reactivation, the ADD row is simply never touched.
 *
 * Deciding between "stale spec" and "mute production path" by reading code is
 * guessing, so production was asked for the EFFECT instead (30-day window):
 *   • 26 `sales_order_mod` rows confirmed, the most recent that same day
 *     → the mod path is alive and reaching QuickBooks.
 *   • 0 confirmed `sales_order` rows ever reactivated
 *     → the behavior this check demanded does not happen. At all.
 * Both together: stale spec, not a broken path.
 *
 * Invariants proven here, against throwaway rows under a synthetic order_id:
 *   1. writePipelineRow({step:"sales_order", status:"pending"}) WITHOUT intent
 *      over a CONFIRMED row → NO-OP (stays 'confirmed'). Protects the ADD from
 *      re-dispatch / a duplicate QB doc.
 *   2. writePipelineRow({..., intent:"mod", qbTxnId}) over that confirmed row
 *      → the ADD's row is UNTOUCHED and a DIFFERENT row id comes back.
 *   2b. that id is a live `sales_order_mod` row carrying the same qb_txn_id —
 *      the edit is queued and dispatchable, which is what "reaches QB" means.
 *   2c. NEGATIVE: still exactly one `sales_order` row. The mod neither
 *      recycled the ADD nor minted a second one (a second ADD is a second QB
 *      document).
 *   3. writePipelineRow({..., intent:"mod"}) WITHOUT qbTxnId → throws (a MOD
 *      must know which doc to modify; never silently degrade into an ADD).
 *
 * Uses a synthetic order_id so it never touches real pipeline rows, and cleans
 * up after itself. Read-only against real data.
 *
 * Run: env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *        ./node_modules/.bin/tsx src/scripts/verify/verify-so-mod-post-confirm.ts
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

/** Status of the ADD's own row. Pinned to step='sales_order' on purpose: the
 *  whole point is that a mod must NOT land here. */
async function statusOf(pool: any): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT status FROM qb_order_pipeline WHERE order_id=$1 AND step='sales_order' ORDER BY created_at DESC LIMIT 1`,
    [SYNTH_ORDER]
  );
  return rows[0]?.status ?? null;
}

async function rowById(
  pool: any,
  id: string
): Promise<{ step: string; status: string; qb_txn_id: string | null } | null> {
  const { rows } = await pool.query(
    `SELECT step, status, qb_txn_id FROM qb_order_pipeline WHERE id=$1`,
    [id]
  );
  return rows[0] ?? null;
}

async function countRows(pool: any, step: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM qb_order_pipeline WHERE order_id=$1 AND step=$2`,
    [SYNTH_ORDER, step]
  );
  return rows[0]?.n ?? 0;
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

    // 2. MOD-intent over confirmed → redirected to the append-only lane. The
    //    ADD's confirm is INTOCABLE and a different row comes back.
    const modRowId = await writePipelineRow({
      orderId: SYNTH_ORDER,
      step: "sales_order",
      status: "pending",
      intent: "mod",
      qbTxnId: SYNTH_TXN,
    });
    ok(
      "2. intent:'mod' over confirmed → the ADD's row keeps its confirm",
      (await statusOf(pool)) === "confirmed"
    );
    ok(
      "2. …and a DIFFERENT row id comes back (the mod got its own row)",
      !!modRowId && modRowId !== rowId
    );

    // 2b. That row must be a live, dispatchable sales_order_mod carrying the
    //     TxnID — without it the edit is queued but can never reach QB.
    const modRow = modRowId ? await rowById(pool, modRowId) : null;
    ok("2b. the new row is step='sales_order_mod'", modRow?.step === "sales_order_mod");
    ok(
      `2b. …status is live, not terminal (got '${modRow?.status ?? "none"}')`,
      modRow?.status === "pending" || modRow?.status === "waiting"
    );
    ok("2b. …and carries the qb_txn_id to modify", modRow?.qb_txn_id === SYNTH_TXN);

    // 2c. NEGATIVE — the mod must not have recycled the ADD, nor minted a
    //     second one. A second `sales_order` row is a second QB document.
    ok(
      "2c. still exactly ONE 'sales_order' row (no recycle, no duplicate ADD)",
      (await countRows(pool, "sales_order")) === 1
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
