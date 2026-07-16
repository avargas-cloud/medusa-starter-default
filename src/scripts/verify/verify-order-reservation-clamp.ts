/**
 * verify-order-reservation-clamp.ts — E2E of the "el POS order define el monto
 * linkeado" mechanism (auto-clamp on reduce · gap on increase · link-time cap ·
 * full-pay release · web-row protection). SANDBOX ONLY.
 *
 * Run with the same env as verify-terminal-payment-round2.ts.
 */
import { FINANCE_MODULE } from "../../modules/finance";
import { reconcileOrderReservations } from "../../lib/finance/reconcile-order-reservations";

const BASE = "http://localhost:9099";
const EMAIL = "r2test@sandbox.local";
const PASS = "r2pass1234";

let passCount = 0;
let failCount = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) {
    passCount++;
    console.log(`  ✅ ${label}`);
  } else {
    failCount++;
    console.error(`  ❌ ${label}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

export default async function script({ container }: { container: any }) {
  if (!process.env.DATABASE_URL?.includes("5499")) {
    throw new Error("SAFETY: DATABASE_URL is not the sandbox (:5499) — aborting.");
  }
  const knex = container.resolve("__pg_connection__") as any;
  const finance = container.resolve(FINANCE_MODULE) as any;

  const loginRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const { token } = (await loginRes.json()) as any;
  if (!token) throw new Error(`Login failed: ${loginRes.status}`);
  const H = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // Pending orders with NO ACTIVE applications — the reconcile math reads
  // payment_application only, so old (voided) invoices don't interfere.
  const { rows: orders } = await knex.raw(
    `SELECT o.id, o.display_id, o.customer_id
       FROM "order" o
      WHERE o.status = 'pending' AND o.deleted_at IS NULL AND o.customer_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_application pa
           WHERE pa.order_id = o.id AND pa.deleted_at IS NULL AND pa.voided_at IS NULL
        )
      ORDER BY o.created_at DESC LIMIT 3`
  );
  if (orders.length < 2) throw new Error(`Need 2 virgin pending orders, found ${orders.length}`);

  const mkPayment = async (customerId: string, cents: number) => {
    const p = await finance.createCustomerPayments({
      customer_id: customerId, amount: cents, method: "credit_card",
      card_brand: "visa", reference: "clamp verify", received_at: new Date(),
      source: "pos", type: "payment", status: "available",
      metadata: { pos_payment_method: "credit_card", card_brand: "visa" },
    });
    return Array.isArray(p) ? p[0] : p;
  };
  const postEditSync = async (orderId: string, posTotalDollars: number) => {
    const r = await fetch(`${BASE}/admin/orders/${orderId}/post-edit-sync`, {
      method: "POST", headers: H,
      body: JSON.stringify({ pos_total: posTotalDollars, skip_qb: true }),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const applyOrder = async (payId: string, orderId: string, cents: number) => {
    const r = await fetch(`${BASE}/admin/finance/payments/${payId}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ order_id: orderId, amount_applied: cents }),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const orderOnlyRows = async (orderId: string) =>
    (await knex.raw(
      `SELECT pa.id, pa.payment_id, pa.amount_applied::numeric AS amt
         FROM payment_application pa
        WHERE pa.order_id = ? AND pa.invoice_id IS NULL
          AND pa.voided_at IS NULL AND pa.deleted_at IS NULL
        ORDER BY pa.created_at`,
      [orderId]
    )).rows;

  const o = orders[0];

  // ═══ R. order $1000, deposit $1500 → link caps at $1000; reduce to $600 → clamp releases $400 ═══
  console.log("\n[R] the user's exact scenario: link → reduce → auto-clamp");
  const pay = await mkPayment(o.customer_id, 150000);
  {
    let r = await postEditSync(o.id, 1000); // set order total $1000
    check(r.status === 200, `post-edit-sync(1000) 200 (got ${r.status})`);

    // Try to link the FULL $1500 — server-side cap must clamp to $1000
    const link = await applyOrder(pay.id, o.id, 150000);
    check(link.status === 200 && Number(link.json?.applied_amount) === 100000,
      `link of 150000 clamped server-side to 100000 (applied ${link.json?.applied_amount})`, link.json);
    let rows = await orderOnlyRows(o.id);
    check(rows.length === 1 && Number(rows[0].amt) === 100000, "one reservation = 100000", rows);

    // Reduce the order to $600 → auto-clamp releases $400
    r = await postEditSync(o.id, 600);
    const rec = r.json?.reservation_reconcile;
    check(r.status === 200 && Number(rec?.released_cents) === 40000,
      `reduce → released_cents 40000 (got ${rec?.released_cents})`, rec);
    rows = await orderOnlyRows(o.id);
    check(rows.length === 1 && Number(rows[0].amt) === 60000, "reservation clamped to 60000", rows);
    check(Number(rec?.gap_cents) === 0, "no gap after clamp", rec);
    // Audit trail landed on the payment
    const { rows: payRows } = await knex.raw(
      `SELECT metadata FROM customer_payment WHERE id = ?`, [pay.id]);
    check(!!payRows[0]?.metadata?.auto_clamp_releases, "auto_clamp_releases audit recorded", payRows[0]?.metadata);
  }

  // ═══ S. increase to $900 → gap reported (modal trigger data) ═══
  console.log("\n[S] increase → gap surfaces for the Cover-with-Credit modal");
  {
    const r = await postEditSync(o.id, 900);
    const rec = r.json?.reservation_reconcile;
    check(r.status === 200 && Number(rec?.gap_cents) === 30000,
      `gap_cents 30000 (got ${rec?.gap_cents})`, rec);
    check(Number(rec?.released_cents) === 0, "nothing released on increase", rec);
    const rows = await orderOnlyRows(o.id);
    check(rows.length === 1 && Number(rows[0].amt) === 60000, "reservation untouched (60000)", rows);
  }

  // ═══ T. link-time cap honors the gap; upsert merges into the same row ═══
  console.log("\n[T] re-link clamps to gap and merges");
  {
    const link = await applyOrder(pay.id, o.id, 99999999);
    check(link.status === 200 && Number(link.json?.applied_amount) === 30000,
      `oversized re-link clamped to gap 30000 (applied ${link.json?.applied_amount})`, link.json);
    const rows = await orderOnlyRows(o.id);
    check(rows.length === 1 && Number(rows[0].amt) === 90000, "still ONE merged row = 90000", rows);
    // Fully covered now → a further link is rejected outright
    const again = await applyOrder(pay.id, o.id, 1000);
    check(again.status === 400 && again.json?.code === "ORDER_BALANCE_FULLY_LINKED",
      `fully-covered order rejects further links (got ${again.status})`, again.json);
  }

  // ═══ U. invoice fully paid → invoice route reconcile releases nothing extra;
  //        payment's never-linked remainder stays AVAILABLE (condición 1) ═══
  console.log("\n[U] full invoice+pay consumes reservation; unlinked remainder untouched");
  {
    const rInv = await fetch(`${BASE}/admin/invoices`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        order_id: o.id, order_display_id: o.display_id, customer_id: o.customer_id,
        items: [{ description: "CLAMP VERIFY", quantity: 1, unit_price: 90000, total: 90000 }],
        subtotal: 90000, discount: 0, shipping: 0, tax: 0, total: 90000,
        amount_paid: 90000, payment_method: "credit_card",
        terminal_payment_id: pay.id, notes: "clamp-verify",
      }),
    });
    check(rInv.status === 201, `invoice 201 (got ${rInv.status})`);
    const rows = await orderOnlyRows(o.id);
    check(rows.length === 0, "reservation fully converted (zero order-only left)", rows);
    const { rows: bound } = await knex.raw(
      `SELECT COALESCE(SUM(amount_applied),0)::numeric AS s FROM payment_application
        WHERE payment_id = ? AND invoice_id IS NOT NULL AND voided_at IS NULL AND deleted_at IS NULL`,
      [pay.id]);
    check(Number(bound[0].s) === 90000, "invoice-bound total 90000", bound);
    const { rows: st } = await knex.raw(`SELECT status FROM customer_payment WHERE id = ?`, [pay.id]);
    check(st[0]?.status === "partially_applied",
      `payment partially_applied — $600 unlinked remainder stays available (got ${st[0]?.status})`);
  }

  // ═══ W. web-capture / refund rows are NEVER clamped ═══
  console.log("\n[W] permanent web/refund order-only rows are protected");
  {
    const o2 = orders[1];
    const webPay = await finance.createCustomerPayments({
      customer_id: o2.customer_id, amount: 5000, method: "card",
      received_at: new Date(), source: "web", type: "payment", status: "applied",
    });
    const webP = Array.isArray(webPay) ? webPay[0] : webPay;
    await finance.createPaymentApplications({
      payment_id: webP.id, invoice_id: null, order_id: o2.id,
      amount_applied: 5000, applied_at: new Date(), applied_by: "verify:web-sim",
    });
    // Order total 0 → for a clampable row this would release everything.
    await knex.raw(
      `UPDATE "order" SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('pos_total', 0.01::numeric) WHERE id = ?`,
      [o2.id]
    );
    const result = await reconcileOrderReservations(
      { resolve: (k: string) => container.resolve(k) }, o2.id,
      { logger: { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) } }
    );
    check((result?.released_cents ?? -1) === 0, "web row NOT released", result);
    const rows = await orderOnlyRows(o2.id);
    check(rows.length === 1 && Number(rows[0].amt) === 5000, "web application intact (5000)", rows);
  }

  console.log(`\n══════ RESULT: ${passCount} passed, ${failCount} failed ══════`);
  if (failCount > 0) throw new Error(`${failCount} assertion(s) failed`);
}
