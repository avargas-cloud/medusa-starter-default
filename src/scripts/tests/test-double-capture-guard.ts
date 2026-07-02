/**
 * test-double-capture-guard.ts  (Phase B — sandbox E2E for the anti double-capture guard)
 *
 * Reproduces the deposit→invoice double-capture flow against a clean order using
 * the REAL registerMedusaPayment + finance module, and asserts the guard:
 *   1. First capture (deposit apply)          → captures full amount.
 *   2. Rebind (same payment, 2nd active app)  → SKIPS (no double capture).
 *   3. A genuine SECOND payment               → captures (regression).
 *
 * SANDBOX ONLY. Usage:
 *   env DATABASE_URL=...sandbox... ./node_modules/.bin/medusa exec ./src/scripts/tests/test-double-capture-guard.ts
 */
import { MedusaContainer } from "@medusajs/framework/types";
import { FINANCE_MODULE } from "../../modules/finance";
import { registerMedusaPayment } from "../../api/admin/invoices/register-medusa-payment";

const ORDER_ID = "order_01KWF7SB7M90E6GQN99THRD6VS"; // #2499 (clean collection)

export default async function testDoubleCaptureGuard({
  container,
}: {
  container: MedusaContainer;
}) {
  const finance = container.resolve(FINANCE_MODULE) as any;
  const knex = container.resolve("__pg_connection__") as any;
  const results: string[] = [];
  const assert = (name: string, cond: boolean, extra = "") => {
    results.push(`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}${extra ? ` (${extra})` : ""}`);
    console.log(results[results.length - 1]);
  };

  const nativeCents = async (): Promise<number> => {
    const { rows } = await knex.raw(
      `SELECT COALESCE(ROUND((SUM(pc.captured_amount)-SUM(COALESCE(pc.refunded_amount,0)))*100),0)::bigint AS n
       FROM order_payment_collection opc JOIN payment_collection pc ON pc.id=opc.payment_collection_id
       WHERE opc.order_id = ?`,
      [ORDER_ID]
    );
    return Number(rows[0]?.n ?? 0);
  };

  const { rows: oRows } = await knex.raw(
    `SELECT customer_id FROM "order" WHERE id = ?`,
    [ORDER_ID]
  );
  const customerId = oRows[0]?.customer_id;
  console.log(`\n[test] order ${ORDER_ID} customer ${customerId}\n`);

  const before = await nativeCents();
  console.log(`[test] native before: ${before}¢`);

  const mkPayment = async (cents: number) =>
    finance.createCustomerPayments({
      customer_id: customerId,
      amount: cents,
      currency: "usd",
      method: "cash",
      status: "available",
      source: "pos",
      type: "payment",
      received_at: new Date(),
    });
  const mkApp = async (paymentId: string, cents: number, invoiceId: string | null) =>
    finance.createPaymentApplications({
      payment_id: paymentId,
      order_id: ORDER_ID,
      invoice_id: invoiceId,
      amount_applied: cents,
      applied_at: new Date(),
    });
  const register = (cents: number, cpId: string) =>
    registerMedusaPayment(container, {
      order_id: ORDER_ID,
      amount: cents,
      payment_method: "cash",
      invoice_total: cents,
      customer_payment_id: cpId,
    });

  // ── 1. Deposit apply → first capture ────────────────────────────────
  const cp1 = await mkPayment(10000);
  await mkApp(cp1.id, 10000, null); // order-only deposit
  const pay1 = await register(10000, cp1.id);
  const afterFirst = await nativeCents();
  assert("1) first capture succeeds", !!pay1, `paymentId=${pay1}`);
  assert("1) native == before + 10000", afterFirst === before + 10000, `native=${afterFirst}`);

  // ── 2. Invoice rebind: 2nd active app for the SAME payment → SKIP ────
  await mkApp(cp1.id, 10000, "inv_fake_rebind"); // now cp1 has 2 active apps
  const pay2 = await register(10000, cp1.id);
  const afterRebind = await nativeCents();
  assert("2) rebind capture is SKIPPED (returns null)", pay2 === null, `returned=${pay2}`);
  assert("2) native UNCHANGED (no double capture)", afterRebind === afterFirst, `native=${afterRebind}`);

  // ── 3. Regression: a genuine SECOND payment still captures ───────────
  const cp2 = await mkPayment(5000);
  await mkApp(cp2.id, 5000, "inv_fake_second");
  const pay3 = await register(5000, cp2.id);
  const afterSecond = await nativeCents();
  assert("3) genuine 2nd payment captures", !!pay3, `paymentId=${pay3}`);
  assert("3) native == +5000", afterSecond === afterRebind + 5000, `native=${afterSecond}`);

  const failed = results.filter((r) => r.startsWith("❌")).length;
  console.log(
    `\n[test] ${failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAILURE(S)`} — native ${before}¢ → ${afterSecond}¢\n`
  );
}
