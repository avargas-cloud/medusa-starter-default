/**
 * Sandbox verification for maybeCompleteOrder (lib/maybe-complete-order.ts).
 *
 * Run against the SANDBOX only:
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *       REDIS_URL=redis://localhost:6399 \
 *   yarn medusa exec ./src/scripts/verify/verify-auto-complete-order.ts
 *
 * Scenarios:
 *   1. Happy path      — an eligible pending order completes (status='completed')
 *   2. Concurrency      — two concurrent calls → exactly ONE completes, other 'busy'
 *   3. Partial payment  — underpaid pending order bails ('not fully paid'), stays pending
 *   4. Draft credit memo — order with open CM bails ('draft credit memo'), stays pending
 *   5. Idempotent re-run — calling again on a completed order bails ('status=completed')
 */
import { Client } from "pg";

import { maybeCompleteOrder } from "../../lib/maybe-complete-order";

const ELIGIBLE_SQL = `
  SELECT o.id, o.display_id
  FROM "order" o
  WHERE o.status='pending' AND o.deleted_at IS NULL AND o.is_draft_order=false
    AND NOT EXISTS (SELECT 1 FROM order_item oi WHERE oi.order_id=o.id AND oi.version=o.version AND oi.fulfilled_quantity<oi.quantity)
    AND GREATEST(
      (SELECT COALESCE(SUM(pi.amount_paid),0) FROM pos_invoice pi WHERE pi.order_id=o.id AND pi.status!='voided'),
      (SELECT COALESCE(ROUND(SUM(pc.captured_amount-COALESCE(pc.refunded_amount,0))*100),0) FROM order_payment_collection opc JOIN payment_collection pc ON pc.id=opc.payment_collection_id WHERE opc.order_id=o.id)
    ) >= (SELECT COALESCE(SUM(pi2.total),1) FROM pos_invoice pi2 WHERE pi2.order_id=o.id AND pi2.status!='voided') - 1
    AND NOT EXISTS (SELECT 1 FROM pos_credit_memo cm WHERE cm.order_id=o.id AND cm.status NOT IN ('completed','voided'))
    AND EXISTS (SELECT 1 FROM pos_invoice pi3 WHERE pi3.order_id=o.id AND pi3.status!='voided')
  ORDER BY o.display_id`;

export default async function verifyAutoComplete({
  container,
}: {
  container: any;
}) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("5499") && !url.includes("sandbox")) {
    console.error(`❌ REFUSING: DATABASE_URL is not the sandbox (${url.slice(0, 40)}…)`);
    return;
  }
  const db = new Client({ connectionString: url });
  await db.connect();

  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "✅ PASS" : "❌ FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
    ok ? pass++ : fail++;
  };

  const statusOf = async (id: string) =>
    (await db.query(`SELECT status FROM "order" WHERE id=$1`, [id])).rows[0]?.status;

  try {
    const eligible = (await db.query(ELIGIBLE_SQL)).rows as {
      id: string;
      display_id: number;
    }[];
    console.log(`\nEligible pending orders in sandbox: ${eligible.length}`);
    if (eligible.length < 3) {
      console.error("❌ Need ≥3 eligible orders for the test; aborting.");
      return;
    }

    // ── Scenario 1: happy path ───────────────────────────────────────────────
    const o1 = eligible[0];
    const r1 = await maybeCompleteOrder(container, o1.id);
    const s1 = await statusOf(o1.id);
    check(
      `1. Happy path — order #${o1.display_id} completes`,
      r1.completed === true && s1 === "completed",
      `result=${JSON.stringify(r1)} status=${s1}`
    );

    // ── Scenario 5: idempotent re-run on the now-completed order ──────────────
    const r5 = await maybeCompleteOrder(container, o1.id);
    check(
      `5. Idempotent re-run — already completed bails`,
      r5.completed === false && r5.reason === "status=completed",
      JSON.stringify(r5)
    );

    // ── Scenario 2: concurrency — two simultaneous calls, exactly one wins ────
    const o2 = eligible[1];
    const [c1, c2] = await Promise.all([
      maybeCompleteOrder(container, o2.id),
      maybeCompleteOrder(container, o2.id),
    ]);
    const s2 = await statusOf(o2.id);
    const wins = [c1, c2].filter((r) => r.completed === true).length;
    const okConc =
      wins === 1 &&
      s2 === "completed" &&
      [c1, c2].some((r) => !r.completed); // the loser bailed (busy / status=completed)
    check(
      `2. Concurrency — exactly one completes, no double`,
      okConc,
      `wins=${wins} c1=${JSON.stringify(c1)} c2=${JSON.stringify(c2)} status=${s2}`
    );

    // ── Scenario 3: partially-paid order stays pending ───────────────────────
    const partial = (
      await db.query(`
      SELECT o.id, o.display_id
      FROM "order" o
      WHERE o.status='pending' AND o.deleted_at IS NULL AND o.is_draft_order=false
        AND EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id=o.id AND pi.status!='voided')
        AND GREATEST(
          (SELECT COALESCE(SUM(pi.amount_paid),0) FROM pos_invoice pi WHERE pi.order_id=o.id AND pi.status!='voided'),
          (SELECT COALESCE(ROUND(SUM(pc.captured_amount-COALESCE(pc.refunded_amount,0))*100),0) FROM order_payment_collection opc JOIN payment_collection pc ON pc.id=opc.payment_collection_id WHERE opc.order_id=o.id)
        ) < (SELECT COALESCE(SUM(pi2.total),0) FROM pos_invoice pi2 WHERE pi2.order_id=o.id AND pi2.status!='voided') - 1
      LIMIT 1`)
    ).rows[0] as { id: string; display_id: number } | undefined;
    if (partial) {
      const r3 = await maybeCompleteOrder(container, partial.id);
      const s3 = await statusOf(partial.id);
      check(
        `3. Partial payment — order #${partial.display_id} stays pending`,
        r3.completed === false && r3.reason === "not fully paid" && s3 === "pending",
        JSON.stringify(r3)
      );
    } else {
      console.log("⏭️  3. Partial payment — no underpaid pending order in sandbox, skipped");
    }

    // ── Scenario 4: draft credit memo blocks completion ──────────────────────
    // Synthesize: take a fresh eligible order, insert a draft CM, assert it bails.
    const o4 = eligible[2];
    const cmId = `cm_verify_${o4.display_id}`;
    await db.query(
      `INSERT INTO pos_credit_memo (id, credit_memo_number, order_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'created', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET status='created'`,
      [cmId, `CM-VERIFY-${o4.display_id}`, o4.id]
    );
    const r4 = await maybeCompleteOrder(container, o4.id);
    const s4 = await statusOf(o4.id);
    check(
      `4. Draft credit memo — order #${o4.display_id} stays pending`,
      r4.completed === false && r4.reason === "draft credit memo" && s4 === "pending",
      JSON.stringify(r4)
    );
    // cleanup the synthetic CM
    await db.query(`DELETE FROM pos_credit_memo WHERE id=$1`, [cmId]);

    console.log(`\n──────────\n${pass} passed, ${fail} failed`);
  } finally {
    await db.end();
  }
}
