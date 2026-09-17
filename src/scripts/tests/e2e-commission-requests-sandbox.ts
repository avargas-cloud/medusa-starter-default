/**
 * e2e-commission-requests-sandbox.ts — solicitudes de comisión del cajero
 * (commission-requests-20260917), de punta a punta contra el sandbox.
 *
 * Qué prueba (y por qué cada cosa):
 *   1. El CAJERO (sin Accounting) puede crear/listar/retirar solicitudes de una
 *      orden, y sigue SIN poder leer la ruta de dinero ni la bandeja global.
 *   2. Las negativas que espejan la asignación: cliente de la orden, identidad
 *      inexistente, dos identidades, pendiente duplicada, orden cancelada (si
 *      el sandbox tiene una), y "ya es beneficiario".
 *   3. Accounting ve la bandeja; reject exige motivo ANTES del PIN, y con PIN
 *      deja rejected + motivo visible para el cajero.
 *   4. La aprobación NO es una ruta: guardar la asignación con esa identidad
 *      (PIN) deja la solicitud approved con order_commission_id y COM-####, en
 *      la MISMA respuesta (`approved_request_ids`). Una pendiente de otra
 *      identidad NO se aprueba de rebote.
 *   5. Retirar: el autor sí, otro cajero no (403), Accounting sí; una ya
 *      revisada no se retira.
 *
 * Repetible: limpia sus solicitudes y la comisión del fixture al empezar.
 *
 * Uso (NUNCA contra producción — aborta si la DB no es :5499):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *       SANDBOX_URL="http://localhost:9099" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-commission-requests-sandbox.ts
 */
import { Pool } from "pg";

const BASE = process.env.SANDBOX_URL ?? "http://localhost:9099";
const ACCOUNTING = { email: "sandbox@test.com", password: "sandbox123" };
const CASHIER = { email: "cajero@test.com", password: "Cajero123" };
const OTHER_CASHIER = { email: "admin@test.com", password: "Admin123" };
const E2E_PIN = "4321";

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};

type Json = Record<string, unknown>;
async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  pin?: string
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(pin ? { "x-supervisor-pin": pin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
}

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const j = (await res.json().catch(() => ({}))) as { token?: string };
  if (!j.token) {
    console.error(`ABORT: login falló para ${email} (${res.status}).`);
    process.exit(2);
  }
  return j.token;
}

interface Req {
  id: string;
  status: string;
  display_name: string;
  customer_id: string | null;
  qb_vendor_id: string | null;
  requested_by_email: string | null;
  review_reason: string | null;
  order_commission_id: string | null;
  commission_number: string | null;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
    console.error("ABORT: DATABASE_URL no apunta al sandbox (:5499).");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

  const acc = await login(ACCOUNTING.email, ACCOUNTING.password);
  const cashier = await login(CASHIER.email, CASHIER.password);
  const other = await login(OTHER_CASHIER.email, OTHER_CASHIER.password);

  // PIN conocido + grant de Accounting para el usuario de test (idempotente,
  // igual que e2e-order-commissions: `POS_OWNER_EMAILS` del backend de sandbox
  // no tiene por qué incluirlo, y sin grant las rutas gateadas dan 403).
  await pool.query(
    `INSERT INTO pos_accounting_grant (id, user_id, email, granted_by)
     SELECT 'pag_e2e_commissions', u.id, lower(u.email), 'e2e-commission-requests'
       FROM "user" u WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL
     ON CONFLICT (id) DO UPDATE SET revoked_at = NULL, revoked_by = NULL, revoke_reason = NULL, updated_at = NOW()`,
    [ACCOUNTING.email]
  );
  await pool.query(
    `UPDATE store SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb`,
    [JSON.stringify({ pos_supervisor_pin: E2E_PIN })]
  );
  // El cajero NO puede tener grant vivo (si una corrida ajena lo dejó, este
  // E2E probaría lo contrario de lo que dice).
  await pool.query(
    `UPDATE pos_accounting_grant g SET revoked_at = NOW(), revoked_by = 'e2e-commission-requests'
       FROM "user" u WHERE g.user_id = u.id AND lower(u.email) IN ($1, $2) AND g.revoked_at IS NULL`,
    [CASHIER.email, OTHER_CASHIER.email]
  );

  // Fixture: una orden viva con cliente; un customer DISTINTO; un vendor real.
  const { rows: orderRows } = await pool.query<{ id: string; customer_id: string; display_id: string }>(
    `SELECT o.id, o.customer_id, o.display_id::text
       FROM "order" o
      WHERE o.deleted_at IS NULL AND o.status <> 'canceled' AND o.customer_id IS NOT NULL
      ORDER BY o.created_at DESC LIMIT 1`
  );
  const order = orderRows[0];
  const { rows: custRows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, COALESCE(first_name || ' ' || last_name, email) AS name FROM customer
      WHERE deleted_at IS NULL AND id <> $1 ORDER BY created_at DESC LIMIT 1`,
    [order?.customer_id ?? ""]
  );
  const { rows: vendorRows } = await pool.query<{ id: string; full_name: string }>(
    `SELECT id, full_name FROM qb_vendor WHERE deleted_at IS NULL AND is_active = true ORDER BY full_name LIMIT 2`
  );
  const { rows: canceledRows } = await pool.query<{ id: string }>(
    `SELECT id FROM "order" WHERE deleted_at IS NULL AND status = 'canceled' ORDER BY created_at DESC LIMIT 1`
  );
  const cust = custRows[0];
  const [vendor, vendor2] = vendorRows;
  if (!order || !cust || !vendor || !vendor2) {
    console.error("ABORT: faltan orden viva, customer distinto o 2 vendors en el sandbox.");
    process.exit(2);
  }
  console.log(`Fixture: orden ${order.display_id} (${order.id}) · customer ${cust.id} · vendors ${vendor.id}, ${vendor2.id}\n`);

  // Reset repetible: solicitudes y comisión del fixture.
  await pool.query(`DELETE FROM commission_request WHERE order_id = $1`, [order.id]);
  const { rows: prior } = await pool.query<{ id: string }>(
    `SELECT r.id FROM order_commission_recipient r JOIN order_commission c ON c.id = r.order_commission_id WHERE c.order_id = $1`,
    [order.id]
  );
  if (prior.length) {
    const ids = prior.map((r) => r.id);
    await pool.query(`DELETE FROM commission_settlement WHERE recipient_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM order_commission_recipient WHERE id = ANY($1)`, [ids]);
  }
  await pool.query(`DELETE FROM order_commission WHERE order_id = $1`, [order.id]);

  const reqPath = `/admin/commissions/orders/${order.id}/requests`;
  const listOrder = async (token: string): Promise<Req[]> =>
    ((await api(token, "GET", reqPath)).body.requests as Req[]) ?? [];

  // ── 1 · El cajero tiene UNA puerta, y es esta ─────────────────────────────
  console.log("── 1. Acceso del cajero");
  const money = await api(cashier, "GET", `/admin/commissions/orders/${order.id}`);
  check("cajero: la ruta de DINERO de la orden sigue cerrada (403)", money.status === 403, `${money.status}`);
  const inbox = await api(cashier, "GET", "/admin/commissions/requests?status=pending");
  check("cajero: la bandeja global de Accounting está cerrada (403)", inbox.status === 403, `${inbox.status}`);
  const empty = await api(cashier, "GET", reqPath);
  check("cajero: lista las solicitudes de la orden (200, vacía tras el reset)", empty.status === 200 && Array.isArray(empty.body.requests) && (empty.body.requests as Req[]).length === 0, `${empty.status}`);

  // ── 2 · Crear + negativas ─────────────────────────────────────────────────
  console.log("\n── 2. Crear una solicitud y las negativas");
  const c1 = await api(cashier, "POST", reqPath, { customer_id: cust.id, display_name: cust.name, note: "E2E: referido en mostrador" });
  check("cajero crea solicitud por CUSTOMER → 201 con request_id", c1.status === 201 && typeof c1.body.request_id === "string", `${c1.status} ${JSON.stringify(c1.body).slice(0, 120)}`);
  const dup = await api(cashier, "POST", reqPath, { customer_id: cust.id, display_name: cust.name });
  check("misma identidad pendiente → 409 duplicate_pending_request", dup.status === 409 && dup.body.code === "duplicate_pending_request", `${dup.status} ${dup.body.code}`);
  const self = await api(cashier, "POST", reqPath, { customer_id: order.customer_id, display_name: "self" });
  check("el cliente de la orden → 409 beneficiary_is_order_customer", self.status === 409 && self.body.code === "beneficiary_is_order_customer", `${self.status} ${self.body.code}`);
  const ghost = await api(cashier, "POST", reqPath, { customer_id: "cus_does_not_exist", display_name: "ghost" });
  check("identidad inexistente → 409 identity_not_found", ghost.status === 409 && ghost.body.code === "identity_not_found", `${ghost.status} ${ghost.body.code}`);
  const both = await api(cashier, "POST", reqPath, { customer_id: cust.id, qb_vendor_id: vendor.id, display_name: "both" });
  check("dos identidades → 400 invalid_input", both.status === 400 && both.body.code === "invalid_input", `${both.status}`);
  const noname = await api(cashier, "POST", reqPath, { qb_vendor_id: vendor.id, display_name: "  " });
  check("sin display_name → 400", noname.status === 400, `${noname.status}`);
  if (canceledRows[0]) {
    const canc = await api(cashier, "POST", `/admin/commissions/orders/${canceledRows[0].id}/requests`, { qb_vendor_id: vendor.id, display_name: vendor.full_name });
    check("orden CANCELADA → 409 order_not_commissionable", canc.status === 409 && canc.body.code === "order_not_commissionable", `${canc.status} ${canc.body.code}`);
  } else {
    console.log("  ⏭  sin orden cancelada en el sandbox — check de orden cancelada omitido (unit test lo cubre)");
  }
  const noOrder = await api(cashier, "POST", `/admin/commissions/orders/order_nope/requests`, { qb_vendor_id: vendor.id, display_name: "x" });
  check("orden inexistente → 404", noOrder.status === 404, `${noOrder.status}`);

  const v1 = await api(cashier, "POST", reqPath, { qb_vendor_id: vendor.id, display_name: vendor.full_name, note: "E2E: vendor a rechazar" });
  check("cajero crea segunda solicitud por VENDOR → 201", v1.status === 201, `${v1.status}`);
  const after2 = await listOrder(cashier);
  check("la orden lista 2 pendientes con requested_by_email del cajero", after2.length === 2 && after2.every((r) => r.status === "pending" && r.requested_by_email === CASHIER.email), JSON.stringify(after2.map((r) => [r.status, r.requested_by_email])));

  // ── 3 · Accounting: bandeja + reject ──────────────────────────────────────
  console.log("\n── 3. Accounting: bandeja y reject con PIN");
  const pendingList = await api(acc, "GET", "/admin/commissions/requests?status=pending");
  const pendingIds = ((pendingList.body.requests as Req[]) ?? []).map((r) => r.id);
  check("bandeja Pending incluye las 2 solicitudes de la orden", pendingList.status === 200 && pendingIds.includes(c1.body.request_id as string) && pendingIds.includes(v1.body.request_id as string), `${pendingList.status} count=${pendingList.body.count}`);
  const badStatus = await api(acc, "GET", "/admin/commissions/requests?status=weird");
  check("status inválido → 400", badStatus.status === 400, `${badStatus.status}`);

  const vReq = v1.body.request_id as string;
  const rejNoReason = await api(acc, "POST", `/admin/commissions/requests/${vReq}`, { action: "reject", reason: "" }, E2E_PIN);
  check("reject sin motivo → 400 (antes de gastar un intento de PIN)", rejNoReason.status === 400, `${rejNoReason.status}`);
  const rejNoPin = await api(acc, "POST", `/admin/commissions/requests/${vReq}`, { action: "reject", reason: "E2E sin pin" });
  check("reject sin PIN → rechazado (401/403), sigue pending", rejNoPin.status === 401 || rejNoPin.status === 403, `${rejNoPin.status}`);
  const rejCashier = await api(cashier, "POST", `/admin/commissions/requests/${vReq}`, { action: "reject", reason: "cajero" }, E2E_PIN);
  check("cajero no puede rechazar (403)", rejCashier.status === 403, `${rejCashier.status}`);
  const rej = await api(acc, "POST", `/admin/commissions/requests/${vReq}`, { action: "reject", reason: "E2E: no corresponde comisión" }, E2E_PIN);
  check("reject con motivo + PIN → 200", rej.status === 200 && rej.body.ok === true, `${rej.status} ${JSON.stringify(rej.body).slice(0, 100)}`);
  const afterRej = (await listOrder(cashier)).find((r) => r.id === vReq);
  check("el cajero ve rejected + motivo", afterRej?.status === "rejected" && afterRej.review_reason === "E2E: no corresponde comisión", JSON.stringify(afterRej));
  const rejAgain = await api(acc, "POST", `/admin/commissions/requests/${vReq}`, { action: "reject", reason: "otra vez" }, E2E_PIN);
  check("rechazar una ya revisada → 409 request_not_pending", rejAgain.status === 409 && rejAgain.body.code === "request_not_pending", `${rejAgain.status}`);

  // ── 4 · Aprobar = asignar ─────────────────────────────────────────────────
  console.log("\n── 4. La asignación aprueba la solicitud (misma tx)");
  const v2 = await api(cashier, "POST", reqPath, { qb_vendor_id: vendor2.id, display_name: vendor2.full_name });
  check("una tercera solicitud (vendor2) queda pendiente como control", v2.status === 201, `${v2.status}`);
  const assign = await api(acc, "POST", `/admin/commissions/orders/${order.id}`, {
    recipients: [{ customer_id: cust.id, display_name: cust.name, percent_bps: 100 }],
  }, E2E_PIN);
  const approvedIds = (assign.body.approved_request_ids as string[]) ?? [];
  check("POST assignment (PIN) → 200 con approved_request_ids = [la del customer]", assign.status === 200 && approvedIds.length === 1 && approvedIds[0] === c1.body.request_id, `${assign.status} ${JSON.stringify(assign.body).slice(0, 160)}`);
  const afterAssign = await listOrder(cashier);
  const cReq = afterAssign.find((r) => r.id === c1.body.request_id);
  const ctrl = afterAssign.find((r) => r.id === v2.body.request_id);
  check("la solicitud del customer quedó approved con order_commission_id y COM-####", cReq?.status === "approved" && cReq.order_commission_id === assign.body.commission_id && /^COM-\d+$/.test(cReq.commission_number ?? ""), JSON.stringify(cReq));
  check("la de vendor2 (no asignada) sigue pending — nada se aprueba de rebote", ctrl?.status === "pending", JSON.stringify(ctrl));
  const { rows: dbReq } = await pool.query<{ status: string; reviewed_by: string | null }>(`SELECT status, reviewed_by FROM commission_request WHERE id = $1`, [c1.body.request_id]);
  check("DB: reviewed_by = el actor de la asignación", dbReq[0]?.status === "approved" && !!dbReq[0].reviewed_by, JSON.stringify(dbReq[0]));
  const again = await api(cashier, "POST", reqPath, { customer_id: cust.id, display_name: cust.name });
  check("pedir de nuevo al ya beneficiario → 409 already_a_recipient", again.status === 409 && again.body.code === "already_a_recipient", `${again.status} ${again.body.code}`);

  // ── 5 · Retirar ───────────────────────────────────────────────────────────
  console.log("\n── 5. Retirar una pendiente");
  const v2Req = v2.body.request_id as string;
  const wOther = await api(other, "DELETE", `${reqPath}/${v2Req}`);
  check("OTRO cajero no puede retirar la ajena → 403 not_request_owner", wOther.status === 403 && wOther.body.code === "not_request_owner", `${wOther.status} ${wOther.body.code}`);
  const wWrongOrder = await api(cashier, "DELETE", `/admin/commissions/orders/order_nope/requests/${v2Req}`);
  check("retirar por otra orden → 404 (el id de la URL no es decorativo)", wWrongOrder.status === 404, `${wWrongOrder.status}`);
  const wMine = await api(cashier, "DELETE", `${reqPath}/${v2Req}`);
  check("el autor retira la suya → 200", wMine.status === 200, `${wMine.status}`);
  const wGone = await api(cashier, "DELETE", `${reqPath}/${v2Req}`);
  check("retirarla de nuevo → 404", wGone.status === 404, `${wGone.status}`);
  const wReviewed = await api(cashier, "DELETE", `${reqPath}/${vReq}`);
  check("una ya revisada (rejected) no se retira → 409 request_not_pending", wReviewed.status === 409, `${wReviewed.status}`);
  const v3 = await api(other, "POST", reqPath, { qb_vendor_id: vendor2.id, display_name: vendor2.full_name });
  const wAcc = await api(acc, "DELETE", `${reqPath}/${v3.body.request_id}`);
  check("Accounting retira la de cualquier cajero → 200", v3.status === 201 && wAcc.status === 200, `${v3.status}/${wAcc.status}`);
  const finalList = await listOrder(cashier);
  check("la lista final muestra sólo approved + rejected (las retiradas no aparecen)", finalList.length === 2 && finalList.every((r) => r.status !== "pending"), JSON.stringify(finalList.map((r) => r.status)));

  await pool.end();
  console.log(`\n${failed === 0 ? "✅" : "❌"} e2e-commission-requests: ${passed}/${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
