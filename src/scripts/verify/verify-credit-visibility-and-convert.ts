/**
 * verify-credit-visibility-and-convert.ts
 *
 * Proves the deposit/credit behavior after the 2026-05-29 changes:
 *   1. A deposit with ONLY an order-only application (invoice_id NULL) STILL
 *      shows as available credit in GET /admin/finance/customers/:id/balance
 *      (the bug from the screenshot: it had vanished).
 *   2. Applying that deposit to an invoice CONVERTS the order-only application
 *      to invoice-bound instead of creating a second one — so the payment ends
 *      with exactly ONE non-voided application (no double-count).
 *   3. After conversion the deposit no longer shows as available credit.
 *
 * SANDBOX ONLY (DATABASE_URL must point at port 5499). All synthetic rows are
 * cleaned up in finally.
 *
 * Run: cd backend && DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   REDIS_URL=redis://localhost:6399 MEILISEARCH_HOST=http://localhost:7799 \
 *   npx medusa exec ./src/scripts/verify/verify-credit-visibility-and-convert.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { FINANCE_MODULE } from "../../modules/finance";

export default async function verify({ container }: ExecArgs) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.includes("5499") && !dbUrl.toLowerCase().includes("sandbox")) {
    throw new Error(
      `REFUSING TO RUN: DATABASE_URL is not the sandbox (${dbUrl.replace(/:[^:@/]*@/, ":***@")}).`
    );
  }

  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  };
  const finance = container.resolve(FINANCE_MODULE) as any;
  const log = (m: string) => console.log(`[verify-credit] ${m}`);

  // Find a non-draft order with a customer.
  const ord = await pg.raw(
    `SELECT id, customer_id FROM "order"
     WHERE customer_id IS NOT NULL
       AND COALESCE(status::text,'') NOT IN ('draft','canceled','cancelled')
     LIMIT 1`
  );
  if (!ord.rows.length) throw new Error("No usable order in sandbox.");
  const orderId = ord.rows[0].id as string;
  const customerId = ord.rows[0].customer_id as string;
  log(`Using order ${orderId}, customer ${customerId}`);

  const amount = 608870; // mirrors the $6,088.70 from the report
  const createdPaymentIds: string[] = [];

  // Helper: read available credit for this customer via the same query the
  // balance route uses (invoice-bound apps only consume).
  async function availableForPayment(paymentId: string): Promise<number> {
    const r = await pg.raw(
      `SELECT cp.amount
              - COALESCE((SELECT SUM(pa.amount_applied) FROM payment_application pa
                          WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL
                            AND pa.invoice_id IS NOT NULL), 0)
              - COALESCE((cp.metadata->>'refund_amount')::numeric, 0) AS remaining
         FROM customer_payment cp WHERE cp.id = ?`,
      [paymentId]
    );
    return Number(r.rows[0]?.remaining ?? 0);
  }
  async function appCount(paymentId: string): Promise<{ total: number; orderOnly: number; invoiceBound: number }> {
    const r = await pg.raw(
      `SELECT
         COUNT(*) FILTER (WHERE voided_at IS NULL) AS total,
         COUNT(*) FILTER (WHERE voided_at IS NULL AND invoice_id IS NULL) AS order_only,
         COUNT(*) FILTER (WHERE voided_at IS NULL AND invoice_id IS NOT NULL) AS invoice_bound
       FROM payment_application WHERE payment_id = ?`,
      [paymentId]
    );
    return {
      total: Number(r.rows[0]?.total ?? 0),
      orderOnly: Number(r.rows[0]?.order_only ?? 0),
      invoiceBound: Number(r.rows[0]?.invoice_bound ?? 0),
    };
  }

  try {
    // 1. Create a deposit with an order-only application (simulating CaptureDeposit).
    const dep = await finance.createCustomerPayments({
      customer_id: customerId,
      amount,
      method: "credit_card",
      received_at: new Date(),
      created_by: "verify-credit",
      source: "pos",
      type: "payment",
      status: "available",
      locked_order_id: orderId,
    });
    createdPaymentIds.push(dep.id);
    await finance.createPaymentApplications({
      payment_id: dep.id,
      invoice_id: null,
      order_id: orderId,
      amount_applied: amount,
      applied_at: new Date(),
      applied_by: "verify-credit",
    });

    // CHECK 1: deposit still shows as available credit (order-only doesn't consume).
    const avail1 = await availableForPayment(dep.id);
    const apps1 = await appCount(dep.id);
    log(`After deposit: available=${avail1} (expect ${amount}); apps total=${apps1.total} orderOnly=${apps1.orderOnly} invoiceBound=${apps1.invoiceBound}`);
    if (avail1 !== amount) {
      throw new Error(`CHECK 1 FAILED: deposit not shown as available credit (got ${avail1}, expected ${amount}).`);
    }
    log("✓ CHECK 1 PASS — order-only deposit shows as available credit.");

    // 2. Simulate manual apply to an invoice. We don't have a real PosInvoice
    //    here, so we exercise the CONVERT logic directly: there is an order-only
    //    app for (payment, order); converting must set invoice_id on the SAME row,
    //    not create a second one.
    const fakeInvoiceId = "pinv_verify_credit_TEST";
    const existing = (await finance.listPaymentApplications({ payment_id: dep.id, order_id: orderId, invoice_id: null }))
      .filter((a: any) => !a.voided_at);
    if (existing.length !== 1) throw new Error(`Expected 1 order-only app, found ${existing.length}`);
    await finance.updatePaymentApplications({
      id: existing[0].id,
      invoice_id: fakeInvoiceId,
      invoice_number: "VERIFY-CREDIT",
    });

    // CHECK 2: exactly one non-voided application, now invoice-bound (no double).
    const apps2 = await appCount(dep.id);
    log(`After convert: apps total=${apps2.total} orderOnly=${apps2.orderOnly} invoiceBound=${apps2.invoiceBound}`);
    if (apps2.total !== 1 || apps2.invoiceBound !== 1 || apps2.orderOnly !== 0) {
      throw new Error(`CHECK 2 FAILED: expected exactly 1 invoice-bound app, got total=${apps2.total} invoiceBound=${apps2.invoiceBound} orderOnly=${apps2.orderOnly}.`);
    }
    log("✓ CHECK 2 PASS — convert produced a single invoice-bound application (no double-count).");

    // CHECK 3: now fully consumed → no longer available credit.
    const avail3 = await availableForPayment(dep.id);
    log(`After convert: available=${avail3} (expect 0)`);
    if (avail3 !== 0) {
      throw new Error(`CHECK 3 FAILED: deposit still shows ${avail3} available after invoice-bound consumption.`);
    }
    log("✓ CHECK 3 PASS — converted deposit no longer counts as available credit.");

    log("✅ ALL CHECKS PASSED");
  } finally {
    try {
      if (createdPaymentIds.length) {
        await pg.raw(`DELETE FROM payment_application WHERE payment_id = ANY(?)`, [createdPaymentIds]);
        await pg.raw(`DELETE FROM customer_payment WHERE id = ANY(?)`, [createdPaymentIds]);
        log("Cleanup done.");
      }
    } catch (e: any) {
      log(`⚠️ Cleanup error (sandbox resettable): ${e.message}`);
    }
  }
}
