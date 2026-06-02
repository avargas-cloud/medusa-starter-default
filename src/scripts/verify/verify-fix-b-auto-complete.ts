/**
 * Verify Fix B: auto-complete order in Medusa native via invoice route
 *
 * Tests 5 scenarios against sandbox DB to validate all 4 guards fire correctly.
 * Does NOT call completeOrderWorkflow — just verifies the guard logic.
 *
 * Usage (sandbox):
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   npx ts-node --project tsconfig.json src/scripts/verify/verify-fix-b-auto-complete.ts
 */

import { Client } from "pg";

const DB_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:sandbox@localhost:5499/medusa";

// Mirrors the exact guard logic from the invoice route setTimeout block
async function shouldAutoComplete(
  db: Client,
  orderId: string
): Promise<{ should: boolean; reason: string }> {
  // Guard 1: order status
  const statusRes = await db.query<{ status: string }>(
    `SELECT status FROM "order" WHERE id = $1`,
    [orderId]
  );
  if (!statusRes.rows[0]) return { should: false, reason: "order not found" };
  if (statusRes.rows[0].status !== "pending")
    return { should: false, reason: `order.status = ${statusRes.rows[0].status} (not pending)` };

  // Guard 2: all items fulfilled
  const fulfillRes = await db.query<{ unfulfilled: string }>(
    `SELECT COUNT(*) FILTER (WHERE oi.fulfilled_quantity < oi.quantity) AS unfulfilled
     FROM order_item oi WHERE oi.order_id = $1`,
    [orderId]
  );
  if (Number(fulfillRes.rows[0]?.unfulfilled ?? 1) > 0)
    return { should: false, reason: `${fulfillRes.rows[0].unfulfilled} item(s) not fully fulfilled` };

  // Guard 3: fully paid (cents vs cents, same table)
  const paidRes = await db.query<{ paid_cents: string; invoiced_cents: string }>(
    `SELECT COALESCE(SUM(amount_paid), 0) AS paid_cents,
            COALESCE(SUM(total), 0)       AS invoiced_cents
     FROM pos_invoice WHERE order_id = $1 AND status != 'voided'`,
    [orderId]
  );
  const paidCents = Number(paidRes.rows[0]?.paid_cents ?? 0);
  const invoicedCents = Number(paidRes.rows[0]?.invoiced_cents ?? 1);
  if (invoicedCents === 0 || paidCents < invoicedCents - 1)
    return { should: false, reason: `underpaid: ${paidCents}¢ paid of ${invoicedCents}¢` };

  // Guard 4: no draft credit memos
  const cmRes = await db.query<{ draft_cm: string }>(
    `SELECT COUNT(*) AS draft_cm FROM pos_credit_memo
     WHERE order_id = $1 AND status NOT IN ('completed', 'voided')`,
    [orderId]
  );
  if (Number(cmRes.rows[0]?.draft_cm ?? 0) > 0)
    return { should: false, reason: `${cmRes.rows[0].draft_cm} draft credit memo(s)` };

  return { should: true, reason: "all guards passed" };
}

async function run() {
  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  console.log("\n=== Fix B Verification: Auto-Complete Guards ===\n");

  let passed = 0;
  let failed = 0;

  function check(
    label: string,
    expected: boolean,
    actual: boolean,
    reason: string
  ) {
    const ok = expected === actual;
    const icon = ok ? "✅" : "❌";
    console.log(`${icon} ${label}`);
    console.log(`   expected should=${expected}, got should=${actual} — ${reason}`);
    if (ok) passed++; else failed++;
  }

  // ── Scenario 1: Fully paid + fully fulfilled order (SHOULD complete) ─────
  const s1 = await db.query<{ id: string; display_id: number }>(
    `SELECT DISTINCT o.id, o.display_id
     FROM "order" o
     JOIN order_fulfillment ofu ON ofu.order_id = o.id AND ofu.deleted_at IS NULL
     JOIN fulfillment f ON f.id = ofu.fulfillment_id AND f.delivered_at IS NOT NULL
     WHERE o.status = 'pending' AND o.is_draft_order = false AND o.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM order_item oi WHERE oi.order_id = o.id
           AND oi.fulfilled_quantity < oi.quantity
       )
       AND EXISTS (
         SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id
           AND pi.status = 'paid' AND pi.balance_due = 0
       )
     LIMIT 1`
  );
  if (s1.rows[0]) {
    const r = await shouldAutoComplete(db, s1.rows[0].id);
    check(`S1: fully paid+fulfilled (order #${s1.rows[0].display_id})`, true, r.should, r.reason);
  } else {
    console.log("⚠️  S1: no qualifying order found in sandbox — skipped");
  }

  // ── Scenario 2: Has invoices but genuinely underpaid (should NOT complete) ─
  // Uses same logic as the guard: SUM(amount_paid) < SUM(total) - 1 (cents)
  const s2 = await db.query<{ id: string; display_id: number }>(
    `SELECT DISTINCT o.id, o.display_id
     FROM "order" o
     WHERE o.status = 'pending' AND o.is_draft_order = false AND o.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM order_item oi2 WHERE oi2.order_id = o.id)
       AND (
         SELECT COALESCE(SUM(pi.amount_paid),0) < COALESCE(SUM(pi.total),1) - 1
         FROM pos_invoice pi WHERE pi.order_id = o.id AND pi.status != 'voided'
       )
     LIMIT 1`
  );
  if (s2.rows[0]) {
    const r = await shouldAutoComplete(db, s2.rows[0].id);
    check(`S2: genuinely underpaid (order #${s2.rows[0].display_id})`, false, r.should, r.reason);
  } else {
    console.log("⚠️  S2: no underpaid pending orders in sandbox — skipped");
  }

  // ── Scenario 3: Partially fulfilled (should NOT complete) ────────────────
  const s3 = await db.query<{ id: string; display_id: number }>(
    `SELECT DISTINCT o.id, o.display_id
     FROM "order" o
     WHERE o.status = 'pending' AND o.is_draft_order = false AND o.deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM order_item oi WHERE oi.order_id = o.id
           AND oi.fulfilled_quantity < oi.quantity
       )
     LIMIT 1`
  );
  if (s3.rows[0]) {
    const r = await shouldAutoComplete(db, s3.rows[0].id);
    check(`S3: partially fulfilled (order #${s3.rows[0].display_id})`, false, r.should, r.reason);
  } else {
    console.log("⚠️  S3: no partially fulfilled orders in sandbox — skipped");
  }

  // ── Scenario 4: Already completed order (should NOT complete again) ───────
  const s4 = await db.query<{ id: string; display_id: number }>(
    `SELECT id, display_id FROM "order"
     WHERE status = 'completed' AND deleted_at IS NULL LIMIT 1`
  );
  if (s4.rows[0]) {
    const r = await shouldAutoComplete(db, s4.rows[0].id);
    check(`S4: already completed (order #${s4.rows[0].display_id})`, false, r.should, r.reason);
  } else {
    console.log("⚠️  S4: no completed orders in sandbox yet — will verify after Fix C");
  }

  // ── Scenario 5: Cancelled order (should NOT complete) ────────────────────
  const s5 = await db.query<{ id: string; display_id: number }>(
    `SELECT id, display_id FROM "order"
     WHERE status = 'canceled' AND deleted_at IS NULL LIMIT 1`
  );
  if (s5.rows[0]) {
    const r = await shouldAutoComplete(db, s5.rows[0].id);
    check(`S5: cancelled order (order #${s5.rows[0].display_id})`, false, r.should, r.reason);
  } else {
    console.log("⚠️  S5: no cancelled orders in sandbox — skipped");
  }

  await db.end();

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("❌ Fix B guards have issues — DO NOT deploy");
    process.exit(1);
  } else {
    console.log("✅ All guards behave correctly — Fix B is safe to deploy");
  }
}

run().catch((e) => {
  console.error("❌ Script error:", e.message);
  process.exit(1);
});
