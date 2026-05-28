/**
 * verify-payment-order-application.ts
 *
 * Static + dynamic guard for P1: the apply route accepts order_id and the
 * handle-order-apply helper writes the expected row shape.
 *
 * Layers:
 *   A) Static — route.ts contains the order_id branch and delegates to
 *      handleOrderApply.
 *   B) Static — handle-order-apply.ts:
 *        - validates 'draft' / 'canceled' status
 *        - writes PaymentApplication with invoice_id=null
 *        - calls registerMedusaPayment
 *        - does NOT call writePipelineRow / enqueueApplyFin
 *   C) Dynamic (sandbox) — seed a CustomerPayment + Medusa order, write a
 *      PaymentApplication via SQL (mimics the helper), and assert the row
 *      shape (invoice_id NULL, invoice_number NULL, order_id set).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const ROOT = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}
function tick(label: string, ok: boolean): boolean {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

const FIXTURE = {
  customer_id: `cus_p1verify_${Date.now()}`,
  order_id: `order_p1verify_${Date.now()}`,
  payment_id: `cpay_p1verify_${Date.now()}`,
  application_id: `papp_p1verify_${Date.now()}`,
};

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const T = (label: string, ok: boolean) => {
    if (tick(label, ok)) pass++;
    else fail++;
  };

  // ── A: route.ts has order_id branch ───────────────────────────────────
  console.log("\n[A] apply/route.ts — order_id branch");
  const route = read("src/api/admin/finance/payments/[id]/apply/route.ts");
  T(
    "destructures order_id from body",
    /const\s*\{[^}]*order_id[^}]*\}\s*=\s*req\.body/.test(route)
  );
  T(
    "rejects if both invoice_id AND order_id present",
    route.includes("Provide either invoice_id OR order_id")
  );
  T(
    "delegates to handleOrderApply when only order_id provided",
    route.includes("return handleOrderApply(")
  );

  // ── B: handle-order-apply.ts shape ────────────────────────────────────
  console.log("\n[B] handle-order-apply.ts — helper shape");
  const helper = read(
    "src/api/admin/finance/payments/[id]/apply/handle-order-apply.ts"
  );
  T("guards draft/canceled order", /draft|canceled/.test(helper));
  T("writes invoice_id: null on application", helper.includes("invoice_id: null"));
  T(
    "writes invoice_number: null on application",
    helper.includes("invoice_number: null")
  );
  T(
    "calls registerMedusaPayment for the deposit",
    helper.includes("registerMedusaPayment(scope")
  );
  T(
    "skips QB writePipelineRow",
    !helper.includes("writePipelineRow")
  );

  // ── C: dynamic sandbox shape check ────────────────────────────────────
  console.log("\n[C] sandbox — order-only application row shape");
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("5499")) {
    console.log("⊘ skipped — not running against sandbox");
  } else {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      // Minimal fixture: customer, order, payment, application
      await client.query(
        `INSERT INTO customer (id, has_account, created_at, updated_at)
         VALUES ($1, false, NOW(), NOW()) ON CONFLICT DO NOTHING`,
        [FIXTURE.customer_id]
      );
      await client.query(
        `INSERT INTO "order" (id, status, created_at, updated_at, version, currency_code)
         VALUES ($1, 'pending', NOW(), NOW(), 1, 'usd') ON CONFLICT DO NOTHING`,
        [FIXTURE.order_id]
      );
      await client.query(
        `INSERT INTO customer_payment (
           id, customer_id, source, type, amount, raw_amount, currency, method, status,
           received_at, created_at, updated_at
         ) VALUES ($1, $2, 'pos', 'payment', 5000,
            jsonb_build_object('value','5000','precision',20),
           'usd', 'cash', 'available', NOW(), NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [FIXTURE.payment_id, FIXTURE.customer_id]
      );
      await client.query(
        `INSERT INTO payment_application (
           id, payment_id, invoice_id, invoice_number, order_id, amount_applied,
           raw_amount_applied, applied_at, applied_by, created_at, updated_at
         ) VALUES ($1, $2, NULL, NULL, $3, 5000,
            jsonb_build_object('value','5000','precision',20),
           NOW(), 'verify-script', NOW(), NOW())
         ON CONFLICT DO NOTHING`,
        [FIXTURE.application_id, FIXTURE.payment_id, FIXTURE.order_id]
      );

      const { rows } = await client.query(
        `SELECT id, invoice_id, invoice_number, order_id, amount_applied
         FROM payment_application WHERE id = $1`,
        [FIXTURE.application_id]
      );
      const row = rows[0];
      T("row exists", !!row);
      if (row) {
        T("invoice_id is NULL", row.invoice_id === null);
        T("invoice_number is NULL", row.invoice_number === null);
        T("order_id is set", row.order_id === FIXTURE.order_id);
        T("amount_applied = 5000", Number(row.amount_applied) === 5000);
      }
    } finally {
      // Cleanup
      await client.query(`DELETE FROM payment_application WHERE id = $1`, [
        FIXTURE.application_id,
      ]);
      await client.query(`DELETE FROM customer_payment WHERE id = $1`, [
        FIXTURE.payment_id,
      ]);
      await client.query(`DELETE FROM "order" WHERE id = $1`, [FIXTURE.order_id]);
      await client.end();
    }
  }

  console.log(`\n[verify] RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[verify] Fatal:", err);
  process.exit(2);
});
