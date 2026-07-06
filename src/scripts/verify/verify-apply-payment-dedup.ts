/**
 * verify-apply-payment-dedup.ts
 *
 * Verifies the dual-keying dup fix for apply_payment pipeline rows.
 *
 * Root cause (fixed in api/admin/invoices/route.ts): the upfront apply_payment
 * "waiting" row was keyed by customer_payment (cpay_) while the direct-exec
 * handler (handle-pos-payment-applied) keys the canonical payment_application
 * (papp_). writePipelineRow dedups on (order_id, step, reference_id) → cpay_ ≠
 * papp_ ⇒ TWO rows ⇒ two ReceivePaymentMod dispatches ⇒ one fails QB 3200
 * "stale edit sequence".
 *
 * This script exercises the REAL writePipelineRow dedup SQL against the sandbox
 * DB, proving:
 *   NEW (fixed):  upfront papp_ waiting → handler papp_ pending  ⇒ 1 row
 *   OLD (bug):    upfront cpay_ waiting → handler papp_ pending  ⇒ 2 rows
 *   BACKSTOP:     partial-unique index rejects a 2nd active papp_ apply_payment
 *
 * SANDBOX ONLY. Uses synthetic order ids (order_TEST_APPLY_DEDUP_*) and cleans
 * them up at the end. Refuses to run against a Railway/prod DATABASE_URL.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     npx ts-node src/scripts/verify/verify-apply-payment-dedup.ts
 */
import { getDbPool } from "../../api/utils/db-pool";
import { writePipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

const TAG = "order_TEST_APPLY_DEDUP";

async function countApplyRows(
  orderId: string
): Promise<{ total: number; byType: Record<string, number> }> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT reference_type, COUNT(*)::int AS c
       FROM qb_order_pipeline
      WHERE order_id = $1 AND step = 'apply_payment'
      GROUP BY reference_type`,
    [orderId]
  );
  const byType: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byType[r.reference_type ?? "null"] = r.c;
    total += r.c;
  }
  return { total, byType };
}

async function cleanup(): Promise<void> {
  const pool = getDbPool();
  await pool.query(`DELETE FROM qb_order_pipeline WHERE order_id LIKE $1`, [
    `${TAG}%`,
  ]);
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set");
  if (url.includes("railway") || url.includes("rlwy.net")) {
    throw new Error(
      "REFUSING to run against a Railway/prod DATABASE_URL — sandbox only (expected localhost:5499)."
    );
  }
  console.log(
    `[verify-apply-dedup] db=${url.replace(/:[^:@]+@/, ":***@")}\n`
  );

  const ts = Date.now();
  const results: { name: string; pass: boolean; detail: string }[] = [];

  // Fresh start
  await cleanup();

  // ── Scenario NEW (fixed behavior): both rows keyed by papp_ ────────────────
  {
    const orderId = `${TAG}_NEW_${ts}`;
    const papp = `papp_TEST_${ts}`;
    // 1) upfront waiting row (as fixed invoices/route.ts now writes it)
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "waiting",
      dependsOn: null,
      medusaRefNumber: "PAY-TEST",
    });
    // 2) handler's row (handle-pos-payment-applied resolves papp_ → pending)
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
      payload: { payment_id: "cpay_x", invoice_id: "inv_x", application_id: papp },
    });
    const { total, byType } = await countApplyRows(orderId);
    const pass = total === 1 && byType["payment_application"] === 1;
    results.push({
      name: "NEW (papp_ upfront + papp_ handler)",
      pass,
      detail: `expected 1 row (payment_application), got total=${total} ${JSON.stringify(byType)}`,
    });
  }

  // ── Scenario OLD (bug repro): cpay_ upfront + papp_ handler ─────────────────
  {
    const orderId = `${TAG}_OLD_${ts}`;
    const cpay = `cpay_TEST_${ts}`;
    const papp = `papp_TEST_OLD_${ts}`;
    // 1) upfront waiting row keyed by customer_payment (pre-fix behavior)
    await writePipelineRow({
      orderId,
      referenceId: cpay,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "waiting",
      dependsOn: null,
      medusaRefNumber: "PAY-TEST",
    });
    // 2) handler's papp_ pending row (different reference_id → no dedup)
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
      payload: { payment_id: cpay, invoice_id: "inv_x", application_id: papp },
    });
    const { total, byType } = await countApplyRows(orderId);
    // This is the BUG: two rows. The test PASSES if it reproduces (total===2),
    // confirming the fix (papp_ keying) is what collapses them.
    const pass = total === 2;
    results.push({
      name: "OLD (cpay_ upfront + papp_ handler) — bug repro",
      pass,
      detail: `expected 2 rows (dual-key), got total=${total} ${JSON.stringify(byType)}`,
    });
  }

  // ── Backstop: partial unique index rejects 2nd active papp_ apply_payment ──
  {
    const orderId = `${TAG}_IDX_${ts}`;
    const papp = `papp_TEST_IDX_${ts}`;
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
    });
    // Force a raw INSERT of a SECOND active row with the same papp_ (simulating a
    // concurrent enqueue that slips past the app-level dedup). The partial unique
    // index uq_qb_pipeline_apply_payment_papp must reject it.
    const pool = getDbPool();
    let rejected = false;
    try {
      const { rows } = await pool.query(
        `INSERT INTO qb_order_pipeline
                (order_id, reference_id, reference_type, step, status, retry_count)
             VALUES ($1,$2,'payment_application','apply_payment','pending',0)
             ON CONFLICT DO NOTHING
             RETURNING id`,
        [`${orderId}_dup`, papp]
      );
      // ON CONFLICT DO NOTHING → 0 rows returned means the index blocked it.
      rejected = rows.length === 0;
    } catch (e: any) {
      // A raw unique_violation (23505) also counts as rejected.
      rejected = e?.code === "23505";
    }
    const { total } = await countApplyRows(orderId);
    const pass = rejected && total === 1;
    results.push({
      name: "BACKSTOP (partial unique index blocks 2nd active papp_)",
      pass,
      detail: `rejected=${rejected}, active papp_ rows for order=${total} (expected 1)`,
    });
  }

  await cleanup();

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log("Results:");
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? "✅ PASS" : "❌ FAIL";
    if (!r.pass) allPass = false;
    console.log(`  ${icon}  ${r.name}\n           ${r.detail}`);
  }
  console.log(
    `\n[verify-apply-dedup] ${allPass ? "ALL PASS ✅" : "SOME FAILED ❌"}`
  );

  await getDbPool().end();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[verify-apply-dedup] fatal:", err);
  try {
    await cleanup();
    await getDbPool().end();
  } catch {}
  process.exit(1);
});
