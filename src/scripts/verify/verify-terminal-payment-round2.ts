/**
 * verify-terminal-payment-round2.ts — E2E verification of the round-2
 * terminal-payment/apply hardening (Fixes A/B1/B2/C). SANDBOX ONLY.
 *
 * Run (sandbox env, back-sb must be up on :9099):
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *       REDIS_URL='redis://localhost:6399' MEILISEARCH_HOST='http://localhost:7799' \
 *       MEILISEARCH_API_KEY='sandbox_master_key' QB_BRIDGE_URL='http://localhost:9999/disabled' \
 *       QB_ORDER_FLOW_ENABLED=true DISABLE_SCHEDULED_JOBS=true \
 *       ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-terminal-payment-round2.ts
 */
import { FINANCE_MODULE } from "../../modules/finance";
import { handlePosPaymentApplied } from "../../lib/quickbooks/handlers/handle-pos-payment-applied";

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

  // ── auth ────────────────────────────────────────────────────────────────
  const loginRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const { token } = (await loginRes.json()) as any;
  if (!token) throw new Error(`Login failed: ${loginRes.status}`);
  const H = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // ── fixtures: distinct pending orders ───────────────────────────────────
  const { rows: orders } = await knex.raw(
    `SELECT o.id, o.display_id, o.customer_id,
            EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id) AS has_inv
       FROM "order" o
      WHERE o.status = 'pending' AND o.deleted_at IS NULL AND o.customer_id IS NOT NULL
      ORDER BY EXISTS (SELECT 1 FROM pos_invoice pi WHERE pi.order_id = o.id) ASC,
               o.created_at DESC
      LIMIT 10`
  );
  if (orders.length < 8) throw new Error(`Need 8 clean pending orders, found ${orders.length}`);

  // The reservation clamp ("order defines linked amount") reads
  // order.metadata.pos_total. Fixture orders are REUSED across suite runs and
  // accumulate invoice-bound applications, so pin the order's REMAINING
  // allowance instead of an absolute total: pos_total = current invoice-bound
  // + the scenario's intended amounts → allowed-to-link is exactly `cents`
  // regardless of fixture history.
  const setPosTotal = async (orderId: string, cents: number) => {
    const { rows } = await knex.raw(
      `SELECT COALESCE(SUM(amount_applied),0)::numeric AS s
         FROM payment_application
        WHERE order_id = ? AND invoice_id IS NOT NULL
          AND voided_at IS NULL AND deleted_at IS NULL`,
      [orderId]
    );
    const boundCents = Math.round(Number(rows[0]?.s ?? 0));
    await knex.raw(
      `UPDATE "order" SET metadata = COALESCE(metadata,'{}'::jsonb) || jsonb_build_object('pos_total', ((?::numeric + ?::numeric) / 100)) WHERE id = ?`,
      [cents, boundCents, orderId]
    );
  };

  const mkPayment = async (customerId: string, cents: number) => {
    const p = await finance.createCustomerPayments({
      customer_id: customerId, amount: cents, method: "credit_card",
      card_brand: "visa", reference: "R2 verify terminal", received_at: new Date(),
      source: "pos", type: "payment", status: "available",
      metadata: { pos_payment_method: "credit_card", card_brand: "visa" },
    });
    return Array.isArray(p) ? p[0] : p;
  };
  const reserve = async (payId: string, orderId: string, cents: number) =>
    fetch(`${BASE}/admin/finance/payments/${payId}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ order_id: orderId, amount_applied: cents }),
    });
  const mkInvoice = async (o: any, totalCents: number, amountPaid: number, extra: Record<string, unknown> = {}) =>
    fetch(`${BASE}/admin/invoices`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        order_id: o.id, order_display_id: o.display_id, customer_id: o.customer_id,
        items: [{ description: "R2 VERIFY ITEM", quantity: 1, unit_price: totalCents, total: totalCents }],
        subtotal: totalCents, discount: 0, shipping: 0, tax: 0, total: totalCents,
        amount_paid: amountPaid, notes: "r2-verify", ...extra,
      }),
    });
  const apps = async (payId: string) =>
    (await knex.raw(
      `SELECT id, invoice_id, order_id, amount_applied::numeric AS amt, voided_at
         FROM payment_application WHERE payment_id = ? AND voided_at IS NULL ORDER BY created_at`,
      [payId]
    )).rows;
  const payStatus = async (payId: string) =>
    (await knex.raw(`SELECT status FROM customer_payment WHERE id = ?`, [payId])).rows[0]?.status;

  // ═══ A. 1:1 exact (regression) ═══
  console.log("\n[A] 1:1 exact");
  {
    const o = orders[0];
    await setPosTotal(o.id, 32163);
    const p = await mkPayment(o.customer_id, 32163);
    check((await reserve(p.id, o.id, 32163)).ok, "order-only reserve ok");
    const r = await mkInvoice(o, 32163, 32163, { terminal_payment_id: p.id, payment_method: "credit_card" });
    check(r.status === 201, `invoice 201 (got ${r.status})`);
    const a = await apps(p.id);
    check(a.length === 1 && a[0].invoice_id != null && Number(a[0].amt) === 32163, "1 invoice-bound app 32163", a);
    check((await payStatus(p.id)) === "applied", "payment applied");

    // ═══ H. idempotent replay (same terminal_payment_id) ═══
    console.log("\n[H] idempotent replay");
    const r2 = await mkInvoice(o, 32163, 32163, { terminal_payment_id: p.id, payment_method: "credit_card" });
    const j2 = (await r2.json()) as any;
    check(r2.status === 200 && j2.idempotent === true, `replay 200 idempotent (got ${r2.status})`, j2.error);
    check((await apps(p.id)).length === 1, "still exactly 1 application");
  }

  // ═══ B. partial (payment > invoice) ═══
  console.log("\n[B] partial");
  {
    const o = orders[1];
    await setPosTotal(o.id, 100000);
    const p = await mkPayment(o.customer_id, 100000);
    await reserve(p.id, o.id, 100000);
    const r = await mkInvoice(o, 60000, 60000, { terminal_payment_id: p.id, payment_method: "credit_card" });
    check(r.status === 201, `invoice 201 (got ${r.status})`);
    const a = await apps(p.id);
    const bound = a.filter((x: any) => x.invoice_id != null);
    const orderOnly = a.filter((x: any) => x.invoice_id == null);
    check(bound.length === 1 && Number(bound[0].amt) === 60000, "invoice-bound 60000", a);
    check(orderOnly.length === 1 && Number(orderOnly[0].amt) === 40000, "order-only remainder 40000", a);
    check((await payStatus(p.id)) === "partially_applied", "payment partially_applied");
  }

  // ═══ C. surplus (reservation < amount_paid) + per-app pipeline rows ═══
  console.log("\n[C] surplus + per-app pipeline rows");
  let cPay: any, cOrder: any, cApps: any[] = [];
  {
    cOrder = orders[2];
    await setPosTotal(cOrder.id, 80000);
    cPay = await mkPayment(cOrder.customer_id, 80000);
    await reserve(cPay.id, cOrder.id, 50000);
    const r = await mkInvoice(cOrder, 80000, 80000, { terminal_payment_id: cPay.id, payment_method: "credit_card" });
    check(r.status === 201, `invoice 201 (got ${r.status})`);
    cApps = await apps(cPay.id);
    const amts = cApps.filter((x: any) => x.invoice_id != null).map((x: any) => Number(x.amt)).sort((x: number, y: number) => x - y);
    check(amts.length === 2 && amts[0] === 30000 && amts[1] === 50000, "2 invoice-bound apps 50000+30000", cApps);
    check((await payStatus(cPay.id)) === "applied", "payment applied");
    await new Promise((res) => setTimeout(res, 1200)); // direct-exec setTimeout(100) + writes
    const { rows: pipeRows } = await knex.raw(
      `SELECT reference_id, status FROM qb_order_pipeline
        WHERE step = 'apply_payment' AND order_id = ? ORDER BY created_at`,
      [cOrder.id]
    );
    const refIds = new Set(pipeRows.map((x: any) => x.reference_id));
    const appIds = cApps.filter((x: any) => x.invoice_id != null).map((x: any) => x.id);
    check(appIds.every((id: string) => refIds.has(id)), "one apply_payment row per papp_ id", { pipeRows, appIds });
  }

  // ═══ D. nonexistent terminal_payment_id → 404, nothing created ═══
  console.log("\n[D] nonexistent terminal payment → 404");
  {
    const o = orders[3];
    const before = (await knex.raw(`SELECT COUNT(*)::int AS c FROM pos_invoice WHERE order_id = ?`, [o.id])).rows[0].c;
    const r = await mkInvoice(o, 5000, 5000, { terminal_payment_id: "cpay_R2_DOES_NOT_EXIST", payment_method: "credit_card" });
    const j = (await r.json()) as any;
    check(r.status === 404 && j.code === "TERMINAL_PAYMENT_NOT_FOUND", `404 TERMINAL_PAYMENT_NOT_FOUND (got ${r.status})`, j);
    const after = (await knex.raw(`SELECT COUNT(*)::int AS c FROM pos_invoice WHERE order_id = ?`, [o.id])).rows[0].c;
    check(before === after, "no invoice row created");
  }

  // ═══ E. amount_paid=0 + terminal → 400, dedup key NOT burned ═══
  console.log("\n[E] zero amount + terminal → 400, then correct retry succeeds");
  {
    const o = orders[4];
    await setPosTotal(o.id, 25000);
    const p = await mkPayment(o.customer_id, 25000);
    await reserve(p.id, o.id, 25000);
    const r0 = await mkInvoice(o, 25000, 0, { terminal_payment_id: p.id });
    const j0 = (await r0.json()) as any;
    check(r0.status === 400 && j0.code === "TERMINAL_PAYMENT_ZERO_AMOUNT", `400 ZERO_AMOUNT (got ${r0.status})`, j0);
    const r1 = await mkInvoice(o, 25000, 25000, { terminal_payment_id: p.id, payment_method: "credit_card" });
    check(r1.status === 201, `retry with real amount → 201 (got ${r1.status}) — dedup key was not burned`);
    const a = await apps(p.id);
    check(a.length === 1 && a[0].invoice_id != null && Number(a[0].amt) === 25000, "converted app 25000", a);
  }

  // ═══ F. negative → 400 (regression) ═══
  console.log("\n[F] negative amount_paid → 400");
  {
    const r = await mkInvoice(orders[5], 5000, -50, { payment_method: "credit_card" });
    check(r.status === 400, `400 (got ${r.status})`);
  }

  // ═══ G. overclaim → 400 (regression) ═══
  console.log("\n[G] overclaim → 400");
  {
    const o = orders[5];
    await setPosTotal(o.id, 80000);
    const p = await mkPayment(o.customer_id, 50000);
    await reserve(p.id, o.id, 50000);
    const r = await mkInvoice(o, 80000, 80000, { terminal_payment_id: p.id, payment_method: "credit_card" });
    check(r.status === 400, `400 (got ${r.status})`, await r.json().catch(() => null));
    const a = await apps(p.id);
    check(a.length === 1 && a[0].invoice_id == null, "reservation untouched (still order-only)", a);
  }

  // Jitter: skip-payment invoices dedup by request-hash (order+total+items) —
  // vary the total per run so the suite is re-runnable on the same orders.
  const J = Date.now() % 89;

  // ═══ I. APPLY ROUTE split (full-convert + surplus) → 2 apps, 2 pipeline rows ═══
  console.log("\n[I] apply route split: convert 50000 + surplus 30000");
  let iPay: any, iInvoiceId = "", iOrder: any, iBound: any[] = [];
  {
    iOrder = orders[6];
    await setPosTotal(iOrder.id, 80000 + J);
    iPay = await mkPayment(iOrder.customer_id, 80000 + J);
    await reserve(iPay.id, iOrder.id, 50000);
    const rInv = await mkInvoice(iOrder, 80000 + J, 0, {}); // skip-payment invoice
    const jInv = (await rInv.json()) as any;
    iInvoiceId = jInv?.invoice?.id;
    check(rInv.status === 201 && !!iInvoiceId, `skip-payment invoice 201 (got ${rInv.status})`);
    const rApply = await fetch(`${BASE}/admin/finance/payments/${iPay.id}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ invoice_id: iInvoiceId, amount_applied: 80000 + J }),
    });
    check(rApply.status === 200, `apply 200 (got ${rApply.status})`, await rApply.clone().json().catch(() => null));
    const a = await apps(iPay.id);
    iBound = a.filter((x: any) => x.invoice_id != null);
    const amts = iBound.map((x: any) => Number(x.amt)).sort((x: number, y: number) => x - y);
    check(amts.length === 2 && amts[0] === 30000 + J && amts[1] === 50000, `2 invoice-bound apps 50000+${30000 + J}`, a);
    check((await payStatus(iPay.id)) === "applied", "payment applied");
    const { rows: pipeRows } = await knex.raw(
      `SELECT reference_id, payload->>'amount_applied' AS pay_amt FROM qb_order_pipeline
        WHERE step = 'apply_payment' AND order_id = ? ORDER BY created_at`,
      [iOrder.id]
    );
    const byRef = Object.fromEntries(pipeRows.map((x: any) => [x.reference_id, Number(x.pay_amt)]));
    check(
      iBound.every((b: any) => byRef[b.id] === Number(b.amt)),
      "one pipeline row per papp_ with ITS OWN amount in payload",
      { byRef, iBound }
    );
  }

  // ═══ J. apply route simple (no reservation) → 1 app, 1 row ═══
  console.log("\n[J] apply route simple");
  {
    const o = orders[7];
    await setPosTotal(o.id, 15000 + J);
    const p = await mkPayment(o.customer_id, 15000 + J);
    const rInv = await mkInvoice(o, 15000 + J, 0, {});
    const jInv = (await rInv.json()) as any;
    const invId = jInv?.invoice?.id;
    const rApply = await fetch(`${BASE}/admin/finance/payments/${p.id}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ invoice_id: invId, amount_applied: 15000 + J }),
    });
    check(rApply.status === 200, `apply 200 (got ${rApply.status})`);
    const a = await apps(p.id);
    check(a.length === 1 && Number(a[0].amt) === 15000 + J && a[0].invoice_id != null, "1 app", a);
  }

  // ═══ L. handler B2 aggregate at bridge boundary ═══
  console.log("\n[L] handler split-aware aggregate (uses scenario I data)");
  {
    await finance.updateCustomerPayments({
      id: iPay.id,
      metadata: { pos_payment_method: "credit_card", qb_txn_id: "R2-PAY-TXN" },
    });
    await knex.raw(
      `UPDATE pos_invoice SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"qb_txn_id":"R2-INV-TXN"}'::jsonb WHERE id = ?`,
      [iInvoiceId]
    );
    await knex.raw(
      `UPDATE customer SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"qb_list_id":"R2-CUST-QB"}'::jsonb WHERE id = ?`,
      [iOrder.customer_id]
    );
    const convertApp = iBound.find((x: any) => Number(x.amt) === 50000);
    // Event carries ONE row's partial amount (50000) — the handler must apply
    // the aggregate (80000). Watch stdout for "Split-aware aggregate" + "$800.00".
    await handlePosPaymentApplied({
      event: {
        name: "pos.payment.applied",
        data: { payment_id: iPay.id, invoice_id: iInvoiceId, order_id: iOrder.id, amount_applied: 50000, application_id: convertApp.id },
      },
      container,
    } as any);
    const { rows } = await knex.raw(
      `SELECT status, error FROM qb_order_pipeline WHERE step='apply_payment' AND reference_id = ?`,
      [convertApp.id]
    );
    check(
      ["failed", "submitted", "confirmed"].includes(rows[0]?.status),
      `handler reached bridge boundary (row status=${rows[0]?.status})`,
      rows[0]
    );

    // ═══ M. all applications voided → handler skips (never re-applies voided money) ═══
    console.log("\n[M] aggregate<=0 → skip");
    for (const b of iBound) {
      await finance.updatePaymentApplications({ id: b.id, voided_at: new Date() });
    }
    await handlePosPaymentApplied({
      event: {
        name: "pos.payment.applied",
        data: { payment_id: iPay.id, invoice_id: iInvoiceId, order_id: iOrder.id, amount_applied: 50000, application_id: convertApp.id },
      },
      container,
    } as any);
    const { rows: r2 } = await knex.raw(
      `SELECT status, error FROM qb_order_pipeline WHERE step='apply_payment' AND reference_id = ?`,
      [convertApp.id]
    );
    check(r2[0]?.status === "skipped", `row skipped (got ${r2[0]?.status})`, r2[0]);
  }

  // ═══ N. UPSERT: second link (different intent) INCREMENTS, never duplicates ═══
  console.log("\n[N] second order-only link increments (unique-constraint safe)");
  const nOrder = orders[8];
  await setPosTotal(nOrder.id, 25000 + J);
  const nPay = await mkPayment(nOrder.customer_id, 40000);
  const K1 = `r2-link:${Date.now()}:a`;
  const K2 = `r2-link:${Date.now()}:b`;
  {
    const r1 = await fetch(`${BASE}/admin/finance/payments/${nPay.id}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ order_id: nOrder.id, amount_applied: 10000, link_intent_key: K1 }),
    });
    check(r1.status === 200, `first link 200 (got ${r1.status})`);
    const r2 = await fetch(`${BASE}/admin/finance/payments/${nPay.id}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ order_id: nOrder.id, amount_applied: 15000, link_intent_key: K2 }),
    });
    check(r2.status === 200, `second link 200 (got ${r2.status})`);
    const a = await apps(nPay.id);
    check(a.length === 1 && a[0].invoice_id == null && Number(a[0].amt) === 25000, "ONE merged order-only row = 25000", a);
    const { rows: metaRows } = await knex.raw(
      `SELECT metadata FROM payment_application WHERE id = ?`, [a[0].id]
    );
    const meta = metaRows[0]?.metadata ?? {};
    check(meta.link_intent_key === K1 && meta.link_intent_keys?.[K2] === 15000, "both intent keys recorded", meta);
  }

  // ═══ O. replays of BOTH intents → no double increment ═══
  console.log("\n[O] intent replays are no-ops");
  {
    for (const [key, label] of [[K1, "K1 (creation scalar)"], [K2, "K2 (merged map)"]] as const) {
      const r = await fetch(`${BASE}/admin/finance/payments/${nPay.id}/apply`, {
        method: "POST", headers: H,
        body: JSON.stringify({ order_id: nOrder.id, amount_applied: 99999, link_intent_key: key }),
      });
      const j = (await r.json()) as any;
      check(r.status === 200 && j.idempotent_replay === true, `replay ${label} → idempotent`, j);
    }
    const a = await apps(nPay.id);
    check(a.length === 1 && Number(a[0].amt) === 25000, "amount unchanged after replays (25000)", a);
  }

  // ═══ P. raw duplicate INSERT → blocked by unique index (23505) ═══
  console.log("\n[P] DB constraint blocks a raw duplicate insert");
  {
    let blocked = false, errMsg = "";
    try {
      await knex.raw(
        `INSERT INTO payment_application
           (id, payment_id, invoice_id, order_id, amount_applied, raw_amount_applied, applied_at)
         VALUES ('papp_r2_dup_test', ?, NULL, ?, 111, '{"value":"111","precision":20}'::jsonb, NOW())`,
        [nPay.id, nOrder.id]
      );
    } catch (e: any) {
      blocked = true;
      errMsg = String(e?.message ?? "");
    }
    check(blocked && /UQ_payment_application_order_only_active|duplicate key/i.test(errMsg),
      "raw INSERT rejected by UQ_payment_application_order_only_active", errMsg.slice(0, 160));
  }

  // ═══ Q. merged reservation converts to invoice-bound; slot frees for relink ═══
  console.log("\n[Q] merged reservation CONVERT + slot reuse");
  {
    const rInv = await mkInvoice(nOrder, 25000 + J, 0, {});
    const jInv = (await rInv.json()) as any;
    const invId = jInv?.invoice?.id;
    check(rInv.status === 201 && !!invId, `skip-payment invoice 201 (got ${rInv.status})`);
    const rApply = await fetch(`${BASE}/admin/finance/payments/${nPay.id}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ invoice_id: invId, amount_applied: 25000 }),
    });
    check(rApply.status === 200, `convert apply 200 (got ${rApply.status})`);
    const a = await apps(nPay.id);
    const bound = a.filter((x: any) => x.invoice_id != null);
    const orderOnly = a.filter((x: any) => x.invoice_id == null);
    check(bound.length === 1 && Number(bound[0].amt) === 25000 && orderOnly.length === 0,
      "merged row fully converted (invoice-bound 25000, zero order-only)", a);
    // Slot freed (row left the partial index) → a fresh link works again.
    // Raise the order total first — the new link-time order-cap would
    // otherwise reject a link on a fully-covered order.
    await setPosTotal(nOrder.id, 30000 + J);
    const rRelink = await fetch(`${BASE}/admin/finance/payments/${nPay.id}/apply`, {
      method: "POST", headers: H,
      body: JSON.stringify({ order_id: nOrder.id, amount_applied: 5000 }),
    });
    check(rRelink.status === 200, `post-convert relink 200 (got ${rRelink.status})`);
    const a2 = await apps(nPay.id);
    const oo2 = a2.filter((x: any) => x.invoice_id == null);
    check(oo2.length === 1 && Number(oo2[0].amt) === 5000, "fresh order-only row 5000 created", a2);
  }

  console.log(`\n══════ RESULT: ${passCount} passed, ${failCount} failed ══════`);
  if (failCount > 0) throw new Error(`${failCount} assertion(s) failed`);
}
