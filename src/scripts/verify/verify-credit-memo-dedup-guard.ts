/**
 * verify-credit-memo-dedup-guard.ts
 *
 * Proves the writePipelineRow ADD-step idempotency guard (Fix A for the CM-1081
 * duplicate: QB #18939 + #18940). Runs against the SANDBOX DB only.
 *
 * Run:
 *   env DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5499/medusa-sandbox \
 *     npx tsx src/scripts/verify/verify-credit-memo-dedup-guard.ts
 *
 * (adjust the sandbox DB name/creds if different — the script refuses to run
 *  unless the host is 127.0.0.1:5499)
 */
import { getDbPool } from "../../api/utils/db-pool";
import { writePipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

const REF = `cmtest_${Date.now()}`;
let failures = 0;

function check(name: string, cond: boolean, extra = ""): void {
  const tag = cond ? "✅ PASS" : "❌ FAIL";
  if (!cond) failures++;
  console.log(`  ${tag} — ${name}${extra ? ` (${extra})` : ""}`);
}

async function rowState(pool: any, id: string) {
  const { rows } = await pool.query(
    `SELECT id, step, status, bridge_op_id, retry_count FROM qb_order_pipeline WHERE id = $1`,
    [id]
  );
  return rows[0];
}

async function countRows(pool: any, step: string) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE reference_id = $1 AND step = $2`,
    [REF, step]
  );
  return rows[0].n as number;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("5499")) {
    throw new Error(
      `Refusing to run: DATABASE_URL must point at the sandbox (127.0.0.1:5499). Got: ${url}`
    );
  }
  const pool = getDbPool();

  try {
    // ── Scenario 1: create step re-enqueued while 'submitted' → NO-OP ─────────
    console.log("Scenario 1: credit_memo re-enqueue while in-flight (submitted)");
    const id1 = await writePipelineRow({
      referenceId: REF,
      referenceType: "credit_memo",
      step: "credit_memo",
      status: "pending",
      payload: { customerId: "X", items: [] },
    });
    // simulate dispatch → submitted with a bridge op id (like op1 → 18939)
    await pool.query(
      `UPDATE qb_order_pipeline SET status='submitted', bridge_op_id='op1-18939', submitted_at=NOW() WHERE id=$1`,
      [id1]
    );
    // the bug trigger: a manual resync re-enqueues the SAME create
    const id2 = await writePipelineRow({
      referenceId: REF,
      referenceType: "credit_memo",
      step: "credit_memo",
      status: "pending",
      payload: { customerId: "X", items: [] },
    });
    const s1 = await rowState(pool, id1);
    check("returns the existing row id (no new row)", id2 === id1, `${id2}`);
    check("row stays 'submitted' (not reset to pending)", s1.status === "submitted", s1.status);
    check("bridge_op_id preserved (op1 not wiped)", s1.bridge_op_id === "op1-18939", s1.bridge_op_id);
    check("exactly ONE credit_memo row exists", (await countRows(pool, "credit_memo")) === 1);

    // ── Scenario 2: create step re-enqueued while 'confirmed' → NO-OP ─────────
    console.log("Scenario 2: credit_memo re-enqueue after 'confirmed'");
    await pool.query(
      `UPDATE qb_order_pipeline SET status='confirmed', confirmed_at=NOW() WHERE id=$1`,
      [id1]
    );
    const id3 = await writePipelineRow({
      referenceId: REF,
      referenceType: "credit_memo",
      step: "credit_memo",
      status: "pending",
      payload: { customerId: "X", items: [] },
    });
    const s2 = await rowState(pool, id1);
    check("returns the existing row id (no new row)", id3 === id1);
    check("row stays 'confirmed'", s2.status === "confirmed", s2.status);
    check("still ONE credit_memo row", (await countRows(pool, "credit_memo")) === 1);

    // ── Scenario 3: genuinely FAILED create CAN still be retried ──────────────
    console.log("Scenario 3: failed create is still reactivatable (legit retry)");
    await pool.query(
      `UPDATE qb_order_pipeline SET status='failed', failed_at=NOW(), bridge_op_id=NULL WHERE id=$1`,
      [id1]
    );
    const id4 = await writePipelineRow({
      referenceId: REF,
      referenceType: "credit_memo",
      step: "credit_memo",
      status: "pending",
      payload: { customerId: "X", items: [] },
    });
    const s3 = await rowState(pool, id1);
    check("reactivates the failed row (same id)", id4 === id1);
    check("failed → pending (retry allowed)", s3.status === "pending", s3.status);

    // ── Scenario 4: idempotent MOD step still reactivates from submitted ──────
    console.log("Scenario 4: credit_memo_mod (idempotent) unaffected by guard");
    const mid1 = await writePipelineRow({
      referenceId: REF,
      referenceType: "credit_memo",
      step: "credit_memo_mod",
      status: "pending",
      payload: {},
    });
    await pool.query(
      `UPDATE qb_order_pipeline SET status='submitted', bridge_op_id='modop' WHERE id=$1`,
      [mid1]
    );
    const mid2 = await writePipelineRow({
      referenceId: REF,
      referenceType: "credit_memo",
      step: "credit_memo_mod",
      status: "pending",
      payload: {},
    });
    const ms = await rowState(pool, mid1);
    check("mod row reactivated to pending (idempotent, expected)", ms.status === "pending", ms.status);
    check("mod returns same row id", mid2 === mid1);
  } finally {
    await pool.query(`DELETE FROM qb_order_pipeline WHERE reference_id = $1`, [REF]);
    console.log(`\nCleaned up test rows for ${REF}`);
  }

  console.log(
    failures === 0
      ? "\n🎉 ALL CHECKS PASSED"
      : `\n💥 ${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
