/**
 * e2e-order-commissions-sandbox.ts — Order Commissions v1 de punta a punta
 * contra el sandbox, HASTA EL BORDE del bridge (QB apagado en sandbox).
 *
 * Cubre: asignación por HTTP con PIN (y sus rechazos: sin PIN, cap, beneficiario
 * = cliente), devengo (pago completo + espera), approve con monto congelado,
 * settle store_credit (crédito POS + par commission_check/commission_payment con
 * payloads correctos), settle vendor_bill (validación + reconcile al "confirmar"
 * el bill), y el dispatch REAL del handler contra un bridge muerto (la fila cae
 * a failed CON retry — transporte, no rechazo).
 *
 * Lo que NO prueba (y queda para la prueba de producción ≤$1 de la Fase 8):
 * la confirmación del poller contra QuickBooks real y el asiento en el company
 * file. El sandbox no tiene bridge por diseño.
 *
 * Uso (NUNCA contra producción — aborta si la DB no es :5499):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *       SANDBOX_URL="http://localhost:9099" \
 *       SANDBOX_ADMIN_EMAIL=... SANDBOX_ADMIN_PASSWORD=... \
 *       QB_BRIDGE_URL="http://127.0.0.1:1" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-order-commissions-sandbox.ts
 */
import { Pool } from "pg";

const BASE = process.env.SANDBOX_URL ?? "http://localhost:9099";
const ADMIN_EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.SANDBOX_ADMIN_PASSWORD ?? "";
const E2E_PIN = "4321";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  pin?: string
): Promise<FetchResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(pin ? { "x-supervisor-pin": pin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
    console.error(`ABORT: DATABASE_URL no apunta al sandbox (:5499).`);
    process.exit(2);
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("ABORT: faltan SANDBOX_ADMIN_EMAIL / SANDBOX_ADMIN_PASSWORD.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  // ── Login ──────────────────────────────────────────────────────────────────
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    console.error(`ABORT: login falló (${authRes.status}).`);
    process.exit(2);
  }
  const token = auth.token;

  // ── Setup: PIN de supervisor conocido + config de comisiones ───────────────
  await pool.query(
    `UPDATE store SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb`,
    [JSON.stringify({ pos_supervisor_pin: E2E_PIN })]
  );

  // Cuenta de comisión ficticia en qb_account (para el camino vendor_bill).
  const EXPENSE_LIST_ID = "8000E2E1-1000000001";
  const CLEARING_LIST_ID = "8000E2E2-1000000002";
  await pool.query(
    `INSERT INTO qb_account (id, qb_list_id, full_name, name, account_type, is_active)
     VALUES ('qbacc_e2e_comm_expense', $1, 'Commission for Sale:Referral', 'Referral', 'CostOfGoodsSold', true),
            ('qbacc_e2e_comm_clearing', $2, 'Referral Commission Clearing', 'Referral Commission Clearing', 'Bank', true)
     ON CONFLICT (id) DO NOTHING`,
    [EXPENSE_LIST_ID, CLEARING_LIST_ID]
  );

  // ── Fixture: una orden PAGADA con invoice viva (y backdateada >30d) ────────
  const { rows: orderRows } = await pool.query<{
    order_id: string;
    customer_id: string;
    display_id: string;
  }>(
    `SELECT o.id AS order_id, o.customer_id, o.display_id::text
       FROM "order" o
       JOIN order_money_projection omp ON omp.order_id = o.id
       JOIN pos_invoice pi ON pi.order_id = o.id
        AND pi.deleted_at IS NULL AND pi.status NOT IN ('draft','voided')
      WHERE o.deleted_at IS NULL
        AND o.customer_id IS NOT NULL
        AND omp.order_total_cents > 0
        AND omp.applied_cents + omp.deposit_cents >= omp.order_total_cents
      ORDER BY o.created_at DESC
      LIMIT 1`
  );
  const fixture = orderRows[0];
  if (!fixture) {
    console.error("ABORT: el sandbox no tiene ninguna orden paga con invoice viva.");
    process.exit(2);
  }
  await pool.query(
    `UPDATE pos_invoice SET created_at = NOW() - INTERVAL '31 days'
      WHERE order_id = $1 AND deleted_at IS NULL AND status NOT IN ('draft','voided')`,
    [fixture.order_id]
  );
  console.log(`Fixture: orden ${fixture.display_id} (${fixture.order_id})\n`);

  // Beneficiarios: un vendor real sincronizado + un customer DISTINTO al de la orden.
  const { rows: vendorRows } = await pool.query<{ id: string; qb_list_id: string; full_name: string }>(
    `SELECT id, qb_list_id, full_name FROM qb_vendor
      WHERE deleted_at IS NULL AND is_active = true AND qb_list_id NOT LIKE 'pending_%'
      ORDER BY full_name LIMIT 1`
  );
  const vendor = vendorRows[0];
  const { rows: custRows } = await pool.query<{ id: string }>(
    `SELECT id FROM customer
      WHERE deleted_at IS NULL AND id <> $1 AND metadata->>'qb_list_id' IS NOT NULL
      LIMIT 1`,
    [fixture.customer_id]
  );
  const beneficiaryCustomer = custRows[0];
  if (!vendor || !beneficiaryCustomer) {
    console.error("ABORT: faltan vendor sincronizado o customer con qb_list_id en el sandbox.");
    process.exit(2);
  }

  const orderPath = `/admin/commissions/orders/${fixture.order_id}`;

  console.log("── 1 · Asignación: guards ──");
  {
    const noPin = await api(token, "POST", orderPath, {
      recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 500 }],
    });
    check("POST sin PIN es rechazado", noPin.status >= 400, `status=${noPin.status}`);

    const badPin = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 500 }] },
      "0000"
    );
    check("POST con PIN equivocado es rechazado", badPin.status >= 400, `status=${badPin.status}`);

    const overCap = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 9999 }] },
      E2E_PIN
    );
    check(
      "cap combinado rechaza 99.99%",
      overCap.status === 400 && overCap.body.code === "cap_exceeded",
      String(overCap.body.code)
    );

    const selfDeal = await api(
      token, "POST", orderPath,
      { recipients: [{ customer_id: fixture.customer_id, display_name: "Self", percent_bps: 100 }] },
      E2E_PIN
    );
    check(
      "beneficiario = cliente de la orden PROHIBIDO",
      selfDeal.status === 400 && selfDeal.body.code === "beneficiary_is_order_customer",
      String(selfDeal.body.code)
    );
  }

  console.log("── 2 · Asignación válida + devengo ──");
  let recipientVendorId = "";
  let recipientCustomerId = "";
  {
    const saved = await api(
      token, "POST", orderPath,
      {
        recipients: [
          { qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 300 },
          { customer_id: beneficiaryCustomer.id, display_name: "E2E Customer Benef", percent_bps: 200 },
        ],
      },
      E2E_PIN
    );
    check("asignación válida guarda", saved.status === 200, JSON.stringify(saved.body).slice(0, 120));

    const got = await api(token, "GET", orderPath);
    const commission = got.body.commission as {
      base_cents: number;
      recipients: Array<{
        id: string; state: string; qb_vendor_id: string | null; customer_id: string | null;
        amount_cents: number; percent_bps: number; eligible_at: string | null;
      }>;
      editable: boolean;
    } | null;
    check("GET devuelve la comisión", !!commission && commission.recipients.length === 2);
    if (commission) {
      const rv = commission.recipients.find((r) => r.qb_vendor_id === vendor.id);
      const rc = commission.recipients.find((r) => r.customer_id === beneficiaryCustomer.id);
      recipientVendorId = rv?.id ?? "";
      recipientCustomerId = rc?.id ?? "";
      check(
        "devengo: pagada + invoice de hace 31d → eligible",
        rv?.state === "eligible" && rc?.state === "eligible",
        `states=${rv?.state}/${rc?.state}`
      );
      const expected = Math.round((commission.base_cents * 300) / 10_000);
      check(
        "monto derivado = base × bps (vendor 3%)",
        rv?.amount_cents === expected,
        `${rv?.amount_cents} vs ${expected}`
      );
    }
  }

  console.log("── 3 · Approve congela el monto ──");
  {
    const approved = await api(
      token, "POST", `${orderPath}/recipients/${recipientVendorId}`,
      { action: "approve" }, E2E_PIN
    );
    check("approve OK", approved.status === 200, JSON.stringify(approved.body).slice(0, 80));
    const { rows } = await pool.query(
      `SELECT state, amount_cents FROM order_commission_recipient WHERE id = $1`,
      [recipientVendorId]
    );
    check(
      "estado approved + amount congelado en DB",
      rows[0]?.state === "approved" && rows[0]?.amount_cents != null,
      `state=${rows[0]?.state} amount=${rows[0]?.amount_cents}`
    );
    const approve2 = await api(
      token, "POST", `${orderPath}/recipients/${recipientVendorId}`,
      { action: "approve" }, E2E_PIN
    );
    check("re-approve rechazado (invalid_state)", approve2.status === 409);
  }

  console.log("── 4 · Settle apagado sin cuentas ──");
  {
    const off = await api(
      token, "POST", `${orderPath}/recipients/${recipientVendorId}`,
      { action: "settle", method: "store_credit" }, E2E_PIN
    );
    check(
      "sin cuentas configuradas → 409 settlement_off",
      off.status === 409 && off.body.code === "settlement_off",
      String(off.body.code)
    );
    const cfg = await api(token, "POST", "/admin/commissions/settings", {
      qb_commission_expense_account: EXPENSE_LIST_ID,
      qb_commission_expense_account_name: "Commission for Sale:Referral",
      qb_commission_clearing_account: CLEARING_LIST_ID,
      qb_commission_clearing_account_name: "Referral Commission Clearing",
    });
    check("settings acepta las 4 cuentas", cfg.status === 200 && cfg.body.settlement_enabled === true);
  }

  console.log("── 5 · Settle store_credit (beneficiario customer, exige link) ──");
  {
    // Primero approve del beneficiario customer.
    await api(token, "POST", `${orderPath}/recipients/${recipientCustomerId}`, { action: "approve" }, E2E_PIN);

    const noLink = await api(
      token, "POST", `${orderPath}/recipients/${recipientCustomerId}`,
      { action: "settle", method: "store_credit" }, E2E_PIN
    );
    check(
      "customer sin vendor linkeado → rechazado",
      noLink.status === 409 &&
        (noLink.body.details as { reason?: string } | undefined)?.reason === "vendor_link_missing",
      JSON.stringify(noLink.body.details ?? noLink.body).slice(0, 100)
    );

    const link = await api(token, "POST", "/admin/commissions/customer-vendor-link", {
      customer_id: beneficiaryCustomer.id,
      qb_vendor_id: vendor.id,
    });
    check("link customer↔vendor creado", link.status === 200, JSON.stringify(link.body).slice(0, 80));

    const settle = await api(
      token, "POST", `${orderPath}/recipients/${recipientCustomerId}`,
      { action: "settle", method: "store_credit" }, E2E_PIN
    );
    check("settle store_credit OK", settle.status === 200, JSON.stringify(settle.body).slice(0, 140));

    const settlementId = String(settle.body.settlement_id ?? "");
    const cpayId = String(settle.body.customer_payment_id ?? "");

    const { rows: cpay } = await pool.query(
      `SELECT amount, method, type, status, metadata FROM customer_payment WHERE id = $1`,
      [cpayId]
    );
    const meta = (cpay[0]?.metadata ?? {}) as Record<string, unknown>;
    check(
      "crédito POS creado: type=payment, method=credit_memo, marcado",
      cpay[0]?.type === "payment" &&
        cpay[0]?.method === "credit_memo" &&
        meta.is_commission_credit === "true" &&
        meta.commission_settlement_id === settlementId,
      `type=${cpay[0]?.type} method=${cpay[0]?.method}`
    );

    const { rows: pipeRows } = await pool.query(
      `SELECT id, step, status, depends_on, payload FROM qb_order_pipeline
        WHERE reference_id = $1 ORDER BY step`,
      [settlementId]
    );
    const checkRow = pipeRows.find((r) => r.step === "commission_check");
    const payRow = pipeRows.find((r) => r.step === "commission_payment");
    check("fila commission_check pending", checkRow?.status === "pending", String(checkRow?.status));
    check(
      "fila commission_payment waiting con depends_on del check",
      payRow?.status === "waiting" && payRow?.depends_on === checkRow?.id,
      `status=${payRow?.status}`
    );
    const cp = (checkRow?.payload ?? {}) as Record<string, unknown>;
    const pp = (payRow?.payload ?? {}) as Record<string, unknown>;
    check(
      "payload del check: vendor ListID real + clearing + expense + RC-ref",
      cp.vendorListId === vendor.qb_list_id &&
        cp.clearingListId === CLEARING_LIST_ID &&
        cp.expenseListId === EXPENSE_LIST_ID &&
        String(cp.refNumber ?? "").startsWith("RC-"),
      JSON.stringify(cp).slice(0, 140)
    );
    check(
      "payload del payment: customer QB ListID + depositAccount clearing + cpay",
      typeof pp.customerListId === "string" &&
        pp.depositAccountFullName === "Referral Commission Clearing" &&
        pp.customerPaymentId === cpayId,
      JSON.stringify(pp).slice(0, 140)
    );

    // Un saldo, un camino: segunda liquidación viva rechazada.
    const again = await api(
      token, "POST", `${orderPath}/recipients/${recipientCustomerId}`,
      { action: "settle", method: "store_credit" }, E2E_PIN
    );
    check("segundo settle rechazado (estado settling)", again.status === 409);

    // Void sobre settling prohibido.
    const voidTry = await api(
      token, "POST", `${orderPath}/recipients/${recipientCustomerId}`,
      { action: "void", reason: "e2e" }, E2E_PIN
    );
    check("void sobre settling rechazado", voidTry.status === 409);

    // Dispatch REAL contra bridge muerto: la fila cae a failed CON retry.
    // QB_API_KEY dummy: sin ella bridgeFetch corta ANTES del fetch (config, no
    // transporte) y el retry no aplica — lo que se prueba acá es el transporte.
    process.env.QB_BRIDGE_URL = process.env.QB_BRIDGE_URL || "http://127.0.0.1:1";
    process.env.QB_API_KEY = process.env.QB_API_KEY || "sandbox-dummy";
    const { dispatchCommissionCheck } = await import(
      "../../lib/quickbooks/handlers/handle-commission-settlement"
    );
    if (!checkRow) {
      check("dispatch contra bridge muerto (SKIP: no hay fila de check)", false);
      await pool.end();
      console.log(`\n❌ ${passed} passed · ${failed + 1} failed (abortado)`);
      process.exit(1);
    }
    await dispatchCommissionCheck(
      {
        id: String(checkRow?.id),
        reference_id: settlementId,
        step: "commission_check",
        payload: cp,
        retry_count: 0,
      },
      { info: () => undefined, warn: () => undefined }
    );
    const { rows: afterDispatch } = await pool.query(
      `SELECT status, next_retry_at, error FROM qb_order_pipeline WHERE id = $1`,
      [checkRow?.id]
    );
    check(
      "bridge muerto → failed con next_retry_at (transporte reintenta)",
      afterDispatch[0]?.status === "failed" && afterDispatch[0]?.next_retry_at != null,
      `status=${afterDispatch[0]?.status} err=${String(afterDispatch[0]?.error).slice(0, 60)}`
    );
  }

  console.log("── 6 · Settle vendor_bill + reconcile ──");
  {
    const badBill = await api(
      token, "POST", `${orderPath}/recipients/${recipientVendorId}`,
      { action: "settle", method: "vendor_bill", vendor_bill_id: "vb_inexistente" }, E2E_PIN
    );
    check("bill inexistente → 404", badBill.status === 404);

    const { rows: amountRows } = await pool.query(
      `SELECT amount_cents FROM order_commission_recipient WHERE id = $1`,
      [recipientVendorId]
    );
    const amountCents = parseInt(String(amountRows[0]?.amount_cents ?? "0"), 10);

    const bill = await api(token, "POST", "/admin/vendor-bills", {
      vendor_id: vendor.id,
      bill_type: "service",
      reference_id: `E2E-COMM-${Date.now().toString(36)}`,
      initial_account_line: { qb_account_list_id: EXPENSE_LIST_ID, amount_cents: amountCents },
    });
    const billId = String((bill.body as { vendor_bill?: { id?: string } }).vendor_bill?.id ?? bill.body.id ?? "");
    check("bill service contra la cuenta de comisión se crea", bill.status === 201 || bill.status === 200, `status=${bill.status} id=${billId}`);

    const settle = await api(
      token, "POST", `${orderPath}/recipients/${recipientVendorId}`,
      { action: "settle", method: "vendor_bill", vendor_bill_id: billId }, E2E_PIN
    );
    check("settle vendor_bill OK", settle.status === 200, JSON.stringify(settle.body).slice(0, 100));

    // Simular la confirmación del bill en QB y verificar el reconcile del listado.
    await pool.query(`UPDATE vendor_bill SET qb_txn_id = 'E2E-QB-TXN' WHERE id = $1`, [billId]);
    const list = await api(token, "GET", "/admin/commissions?tab=closed");
    const rows = (list.body.rows ?? []) as Array<{ recipient_id: string; state: string }>;
    const closedRow = rows.find((r) => r.recipient_id === recipientVendorId);
    check(
      "reconcile: bill con qb_txn_id cierra settlement y recipient",
      closedRow?.state === "closed",
      `state=${closedRow?.state}`
    );
  }

  console.log("── 7 · Guardas post-devengo ──");
  {
    const resave = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 100 }] },
      E2E_PIN
    );
    check(
      "re-guardar la asignación con beneficiarios no-draft → 409 assignment_locked",
      resave.status === 409 && resave.body.code === "assignment_locked",
      String(resave.body.code)
    );
  }

  await pool.end();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed · ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
