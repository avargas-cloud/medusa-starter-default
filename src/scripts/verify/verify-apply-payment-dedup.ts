/**
 * verify-apply-payment-dedup.ts
 *
 * Verifies the dual-keying dup fix + the durable hardening for apply_payment
 * pipeline rows (cpay_ vs papp_).
 *
 * Root cause: an apply_payment row keyed by customer_payment (cpay_) alongside the
 * canonical payment_application (papp_) row. writePipelineRow dedups on
 * (order_id, step, reference_id) → cpay_ ≠ papp_ ⇒ TWO rows ⇒ two ReceivePaymentMod
 * dispatches ⇒ one fails QB 3200 "stale edit sequence".
 *
 * Hardening under test (docs/APPLY_PAYMENT_DUAL_KEY_HARDENING_PLAN.md):
 *   Fix 2 — writePipelineRow canonicalizes cpay_ → papp_ before any SQL:
 *            #1 payload.application_id, #2 (payment_id, invoice_id),
 *            #3 UNIQUE (payment_id, order_id). 0 or >1 leaves cpay_ (non-regressive).
 *   Fix 3 — the dispatch pass skips a cpay_ apply_payment row when a papp_ sibling
 *            (processing/submitted/confirmed) exists for the same
 *            (payment_id, invoice_id). Tested here at the SQL level (the exact
 *            sibling-detection query); the full cron path is covered by the
 *            sandbox E2E.
 *
 * SANDBOX ONLY. Uses synthetic ids (TEST_APPLY_DEDUP_*) and cleans them up at the
 * end. Refuses to run against a Railway/prod DATABASE_URL.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     npx ts-node src/scripts/verify/verify-apply-payment-dedup.ts
 */
import { getDbPool } from "../../api/utils/db-pool";
import { writePipelineRow } from "../../lib/quickbooks/pipeline/row-mutations";

const TAG = "order_TEST_APPLY_DEDUP";
const CP_TAG = "cpay_TEST_APPLY_DEDUP";
const PA_TAG = "papp_TEST_APPLY_DEDUP";

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

/** Seeds a synthetic customer_payment + payment_application (no FK to customer). */
async function seedPaymentApp(input: {
  cpay: string;
  papp: string;
  orderId: string;
  invoiceId: string | null;
}): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO customer_payment
        (id, customer_id, source, type, amount, currency, method, status,
         received_at, raw_amount, created_at, updated_at, medusa_payment_synced)
     VALUES ($1,'cust_TEST','pos','payment',1,'usd','cash','applied',
         NOW(), '{"value":"1","precision":20}'::jsonb, NOW(), NOW(), false)
     ON CONFLICT (id) DO NOTHING`,
    [input.cpay]
  );
  await pool.query(
    `INSERT INTO payment_application
        (id, payment_id, invoice_id, order_id, amount_applied, applied_at,
         raw_amount_applied, created_at, updated_at)
     VALUES ($1,$2,$3,$4,1,NOW(),'{"value":"1","precision":20}'::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO NOTHING`,
    [input.papp, input.cpay, input.invoiceId, input.orderId]
  );
}

async function cleanup(): Promise<void> {
  const pool = getDbPool();
  await pool.query(`DELETE FROM qb_order_pipeline WHERE order_id LIKE $1`, [
    `${TAG}%`,
  ]);
  await pool.query(`DELETE FROM payment_application WHERE id LIKE $1`, [
    `${PA_TAG}%`,
  ]);
  await pool.query(`DELETE FROM customer_payment WHERE id LIKE $1`, [
    `${CP_TAG}%`,
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
  console.log(`[verify-apply-dedup] db=${url.replace(/:[^:@]+@/, ":***@")}\n`);

  const ts = Date.now();
  const results: { name: string; pass: boolean; detail: string }[] = [];

  await cleanup();

  // ── 1. NEW baseline: both rows keyed papp_ ⇒ 1 row ─────────────────────────
  {
    const orderId = `${TAG}_NEW_${ts}`;
    const papp = `${PA_TAG}_NEW_${ts}`;
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "waiting",
      medusaRefNumber: "PAY-TEST",
    });
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
      payload: { payment_id: "cpay_x", invoice_id: "inv_x", application_id: papp },
    });
    const { total, byType } = await countApplyRows(orderId);
    results.push({
      name: "NEW (papp_ upfront + papp_ handler) ⇒ 1 row",
      pass: total === 1 && byType["payment_application"] === 1,
      detail: `expected 1 payment_application, got total=${total} ${JSON.stringify(byType)}`,
    });
  }

  // ── 2. GUARD via payload.application_id: cpay_ upfront gets canonicalized ───
  //    Proves Fix 2 resolution #1 — the gate/handler pass application_id in
  //    payload, so even a cpay_ referenceType collapses onto the papp_ row.
  {
    const orderId = `${TAG}_GP_${ts}`;
    const cpay = `${CP_TAG}_GP_${ts}`;
    const papp = `${PA_TAG}_GP_${ts}`;
    // upfront cpay_ row BUT carrying payload.application_id (what a fixed caller sends)
    await writePipelineRow({
      orderId,
      referenceId: cpay,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "waiting",
      medusaRefNumber: "PAY-TEST",
      payload: { payment_id: cpay, invoice_id: "inv_x", application_id: papp },
    });
    // handler papp_ row
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
      payload: { payment_id: cpay, invoice_id: "inv_x", application_id: papp },
    });
    const { total, byType } = await countApplyRows(orderId);
    results.push({
      name: "GUARD payload.application_id (cpay_ → papp_) ⇒ 1 row",
      pass: total === 1 && byType["payment_application"] === 1 && !byType["customer_payment"],
      detail: `expected 1 payment_application, got total=${total} ${JSON.stringify(byType)}`,
    });
  }

  // ── 3. GUARD via DB lookup: cpay_ with NO payload, unique (payment_id,order) ─
  //    Proves Fix 2 resolution #3 — a stale/legacy caller passing only cpay_ is
  //    canonicalized by the writePipelineRow guard when exactly one application
  //    exists for (payment_id, order_id).
  {
    const orderId = `${TAG}_GL_${ts}`;
    const cpay = `${CP_TAG}_GL_${ts}`;
    const papp = `${PA_TAG}_GL_${ts}`;
    await seedPaymentApp({ cpay, papp, orderId, invoiceId: `inv_GL_${ts}` });
    // cpay_ row, NO payload → guard must resolve papp_ via (payment_id, order_id)
    await writePipelineRow({
      orderId,
      referenceId: cpay,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "waiting",
      medusaRefNumber: "PAY-TEST",
    });
    // handler papp_ row → should dedup in place
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
      payload: { payment_id: cpay, invoice_id: `inv_GL_${ts}`, application_id: papp },
    });
    const { total, byType } = await countApplyRows(orderId);
    results.push({
      name: "GUARD DB lookup (cpay_ no payload → papp_) ⇒ 1 row",
      pass: total === 1 && byType["payment_application"] === 1 && !byType["customer_payment"],
      detail: `expected 1 payment_application, got total=${total} ${JSON.stringify(byType)}`,
    });
  }

  // ── 4. AMBIGUOUS non-regression: 2 applications same (payment_id, order) ────
  //    Guard must NOT mis-key — leaves cpay_ (caller must pass application_id).
  {
    const orderId = `${TAG}_AMB_${ts}`;
    const cpay = `${CP_TAG}_AMB_${ts}`;
    const pappA = `${PA_TAG}_AMB_A_${ts}`;
    const pappB = `${PA_TAG}_AMB_B_${ts}`;
    await seedPaymentApp({ cpay, papp: pappA, orderId, invoiceId: `inv_AMB_A_${ts}` });
    await seedPaymentApp({ cpay, papp: pappB, orderId, invoiceId: `inv_AMB_B_${ts}` });
    await writePipelineRow({
      orderId,
      referenceId: cpay,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "waiting",
      medusaRefNumber: "PAY-TEST",
    });
    const { byType } = await countApplyRows(orderId);
    results.push({
      name: "AMBIGUOUS (2 apps) leaves cpay_ — no mis-key",
      pass: byType["customer_payment"] === 1 && !byType["payment_application"],
      detail: `expected 1 customer_payment (unresolved), got ${JSON.stringify(byType)}`,
    });
  }

  // ── 5. LEGACY non-regression: no application at all → cpay_ preserved ───────
  {
    const orderId = `${TAG}_LEG_${ts}`;
    const cpay = `${CP_TAG}_LEG_${ts}`;
    await writePipelineRow({
      orderId,
      referenceId: cpay,
      referenceType: "customer_payment",
      step: "apply_payment",
      status: "waiting",
      medusaRefNumber: "PAY-TEST",
    });
    const { total, byType } = await countApplyRows(orderId);
    results.push({
      name: "LEGACY (no application) leaves cpay_ ⇒ 1 row",
      pass: total === 1 && byType["customer_payment"] === 1,
      detail: `expected 1 customer_payment, got total=${total} ${JSON.stringify(byType)}`,
    });
  }

  // ── 6. BACKSTOP: partial unique index blocks a 2nd active papp_ ─────────────
  {
    const orderId = `${TAG}_IDX_${ts}`;
    const papp = `${PA_TAG}_IDX_${ts}`;
    await writePipelineRow({
      orderId,
      referenceId: papp,
      referenceType: "payment_application",
      step: "apply_payment",
      status: "pending",
    });
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
      rejected = rows.length === 0;
    } catch (e: any) {
      rejected = e?.code === "23505";
    }
    const { total } = await countApplyRows(orderId);
    results.push({
      name: "BACKSTOP (partial unique index blocks 2nd active papp_)",
      pass: rejected && total === 1,
      detail: `rejected=${rejected}, active papp_ rows=${total} (expected 1)`,
    });
  }

  // ── 7. DISPATCH-NET (Fix 3) sibling-detection SQL ──────────────────────────
  //    The exact query resubmit-by-step uses to detect a papp_ sibling before
  //    dispatching a cpay_ row. Seed a confirmed papp_ apply row + its
  //    application, then assert the sibling query matches by (payment_id,
  //    invoice_id) — i.e. the cpay_ row WOULD be skipped.
  {
    const orderId = `${TAG}_NET_${ts}`;
    const cpay = `${CP_TAG}_NET_${ts}`;
    const papp = `${PA_TAG}_NET_${ts}`;
    const invoiceId = `inv_NET_${ts}`;
    await seedPaymentApp({ cpay, papp, orderId, invoiceId });
    // confirmed papp_ apply_payment row (the sibling)
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO qb_order_pipeline
              (order_id, reference_id, reference_type, step, status, retry_count)
           VALUES ($1,$2,'payment_application','apply_payment','confirmed',0)
           ON CONFLICT DO NOTHING`,
      [orderId, papp]
    );
    const { rows: sibling } = await pool.query(
      `SELECT p.id
         FROM qb_order_pipeline p
         JOIN payment_application pa ON pa.id = p.reference_id
        WHERE p.step = 'apply_payment'
          AND p.reference_type = 'payment_application'
          AND p.status IN ('processing', 'submitted', 'confirmed')
          AND pa.payment_id = $1
          AND pa.invoice_id = $2
        LIMIT 1`,
      [cpay, invoiceId]
    );
    results.push({
      name: "DISPATCH-NET sibling detected (cpay_ would be skipped)",
      pass: sibling.length === 1,
      detail: `expected 1 papp_ sibling for (payment_id, invoice_id), got ${sibling.length}`,
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
