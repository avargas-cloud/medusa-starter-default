/**
 * e2e-outsourced-services-sandbox.ts — Order Outsourced Services de punta a
 * punta contra el sandbox, HASTA EL BORDE del bridge (QB apagado por diseño).
 *
 * Cubre por HTTP real: alta con PIN (y su rechazo sin PIN), N servicios por
 * orden con el mismo vendor y tipo, approve (número OSV + cuenta congelada),
 * settle contra un vendor bill validado, y el reconcile a `posted` al aparecer
 * `qb_txn_id`.
 *
 * Y las aserciones NEGATIVAS, que son la mitad que importa:
 *  - un bill ya reclamado por una COMISIÓN no puede liquidar un servicio (el
 *    modo de falla que ninguna de las dos features ve sola: sus índices
 *    parciales viven cada uno en su tabla);
 *  - un bill con el monto equivocado, con la cuenta equivocada o de otro vendor
 *    se rechaza;
 *  - void desde `settling` y desde `posted` se rechazan;
 *  - un tipo SIN cuenta contable no se puede aprobar (kill switch por tipo);
 *  - un servicio de OTRA orden no se opera bajo el lock de esta.
 *
 * REPETIBLE: limpia lo suyo al empezar (servicios, settlements y el tipo de
 * prueba). No usa cache en proceso, así que no necesita espera entre corridas
 * — a diferencia del E2E de comisiones, cuyo config tiene TTL de 60 s.
 *
 * Uso (NUNCA contra producción — aborta si la DB no es :5499):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *       SANDBOX_URL="http://localhost:9099" \
 *       SANDBOX_ADMIN_EMAIL=... SANDBOX_ADMIN_PASSWORD=... \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-outsourced-services-sandbox.ts
 */
import { Pool } from "pg";

const BASE = process.env.SANDBOX_URL ?? "http://localhost:9099";
const ADMIN_EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.SANDBOX_ADMIN_PASSWORD ?? "";
const E2E_PIN = "4321";

/** Cuenta de subcontrato ficticia. El allowlist matchea por prefijo + COGS. */
const SVC_ACCOUNT_LIST_ID = "8000E2E9-1000000009";
const SVC_ACCOUNT_NAME = "Subcontractor Labor";
/** Cuenta de comisión, para probar que los dos conjuntos no se cruzan. */
const COMM_ACCOUNT_LIST_ID = "8000E2E1-1000000001";

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
    console.error("ABORT: DATABASE_URL no apunta al sandbox (:5499).");
    process.exit(2);
  }
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error("ABORT: faltan SANDBOX_ADMIN_EMAIL / SANDBOX_ADMIN_PASSWORD.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });

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

  // ── Setup ──────────────────────────────────────────────────────────────────
  await pool.query(
    `UPDATE store SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb`,
    [JSON.stringify({ pos_supervisor_pin: E2E_PIN })]
  );
  await pool.query(
    `INSERT INTO qb_account (id, qb_list_id, full_name, name, account_type, is_active)
     VALUES ('qbacc_e2e_subcontract', $1, $2, 'Subcontractor Labor', 'CostOfGoodsSold', true),
            ('qbacc_e2e_comm_expense', $3, 'Commission for Sale:Referral', 'Referral', 'CostOfGoodsSold', true)
     ON CONFLICT (id) DO NOTHING`,
    [SVC_ACCOUNT_LIST_ID, SVC_ACCOUNT_NAME, COMM_ACCOUNT_LIST_ID]
  );

  // Los 3 tipos sembrados apuntan a la cuenta del sandbox.
  await pool.query(
    `UPDATE outsourced_service_type
        SET qb_account_list_id = $1, qb_account_full_name = $2, is_active = true
      WHERE code IN ('programming','assembly','on_site_installation')`,
    [SVC_ACCOUNT_LIST_ID, SVC_ACCOUNT_NAME]
  );
  // Un tipo SIN cuenta, para el kill switch.
  await pool.query(
    `INSERT INTO outsourced_service_type (id, code, display_name, sort_order)
     VALUES ('ostp_e2e_noaccount', 'e2e_noaccount', 'E2E No Account', 900)
     ON CONFLICT (id) DO UPDATE
        SET qb_account_list_id = NULL, qb_account_full_name = NULL, is_active = true`
  );

  // ── Fixtures: una orden y dos vendors ──────────────────────────────────────
  const { rows: orderRows } = await pool.query<{ order_id: string; display_id: string }>(
    `SELECT id AS order_id, display_id::text
       FROM "order" WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 2`
  );
  const fixture = orderRows[0];
  const otherOrder = orderRows[1];
  if (!fixture || !otherOrder) {
    console.error("ABORT: el sandbox necesita al menos 2 órdenes.");
    process.exit(2);
  }

  const { rows: vendorRows } = await pool.query<{ id: string; full_name: string }>(
    `SELECT id, COALESCE(full_name, name, id) AS full_name
       FROM qb_vendor WHERE deleted_at IS NULL AND qb_list_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 2`
  );
  const vendorA = vendorRows[0];
  const vendorB = vendorRows[1];
  if (!vendorA || !vendorB) {
    console.error("ABORT: el sandbox necesita al menos 2 vendors sincronizados.");
    process.exit(2);
  }
  console.log(
    `Fixture: orden ${fixture.display_id} · vendors "${vendorA.full_name}" / "${vendorB.full_name}"\n`
  );

  // ── Limpieza de corridas anteriores ────────────────────────────────────────
  const reset = async (): Promise<void> => {
    await pool.query(
      `DELETE FROM outsourced_service_settlement
        WHERE service_id IN (SELECT id FROM order_outsourced_service WHERE order_id = ANY($1))`,
      [[fixture.order_id, otherOrder.order_id]]
    );
    await pool.query(`DELETE FROM order_outsourced_service WHERE order_id = ANY($1)`, [
      [fixture.order_id, otherOrder.order_id],
    ]);
    await pool.query(
      `DELETE FROM vendor_bill_line WHERE vendor_bill_id LIKE 'vb_e2e_osvc%'`
    );
    await pool.query(`DELETE FROM vendor_bill WHERE id LIKE 'vb_e2e_osvc%'`);
    await pool.query(`DELETE FROM commission_settlement WHERE id LIKE 'cset_e2e_osvc%'`);
  };
  await reset();

  const typeIds = await pool
    .query<{ id: string; code: string }>(
      `SELECT id, code FROM outsourced_service_type WHERE deleted_at IS NULL`
    )
    .then((r) => new Map(r.rows.map((x) => [x.code, x.id])));
  const INSTALL_TYPE = typeIds.get("on_site_installation") as string;
  const PROGRAMMING_TYPE = typeIds.get("programming") as string;
  const NOACCOUNT_TYPE = typeIds.get("e2e_noaccount") as string;

  const svcPath = `/admin/outsourced-services/orders/${fixture.order_id}`;
  const AMOUNT = 45000;

  // ── §1 · Alta ──────────────────────────────────────────────────────────────
  console.log("§1 · Alta de un servicio");
  {
    const noPin = await api(token, "POST", svcPath, {
      qb_vendor_id: vendorA.id,
      vendor_display_name: vendorA.full_name,
      service_type_id: INSTALL_TYPE,
      amount_cents: AMOUNT,
    });
    check(
      "sin PIN se rechaza",
      noPin.status === 401 || noPin.status === 403,
      `status ${noPin.status}`
    );

    const created = await api(
      token,
      "POST",
      svcPath,
      {
        qb_vendor_id: vendorA.id,
        vendor_display_name: vendorA.full_name,
        service_type_id: INSTALL_TYPE,
        amount_cents: AMOUNT,
        description: "E2E install",
      },
      E2E_PIN
    );
    check("con PIN se crea", created.status === 200 && !!created.body.id);

    const zero = await api(
      token,
      "POST",
      svcPath,
      {
        qb_vendor_id: vendorA.id,
        vendor_display_name: vendorA.full_name,
        service_type_id: INSTALL_TYPE,
        amount_cents: 0,
      },
      E2E_PIN
    );
    check("monto 0 se rechaza", zero.status === 400, `status ${zero.status}`);

    const noVendor = await api(
      token,
      "POST",
      svcPath,
      { qb_vendor_id: "", vendor_display_name: "", service_type_id: INSTALL_TYPE, amount_cents: 100 },
      E2E_PIN
    );
    check("sin vendor se rechaza", noVendor.status === 400);

    // N por orden, mismo vendor y mismo tipo: DOS visitas son legítimas.
    const second = await api(
      token,
      "POST",
      svcPath,
      {
        qb_vendor_id: vendorA.id,
        vendor_display_name: vendorA.full_name,
        service_type_id: INSTALL_TYPE,
        amount_cents: 12500,
      },
      E2E_PIN
    );
    check(
      "mismo vendor + mismo tipo + misma orden: ENTRA (dos visitas son legítimas)",
      second.status === 200
    );

    const list = await api(token, "GET", svcPath);
    const services = (list.body.services ?? []) as Array<Record<string, unknown>>;
    check("el GET devuelve los 2 servicios", services.length === 2, `${services.length}`);
    check(
      "un borrador NO tiene número OSV todavía",
      services.every((s) => s.service_number === null)
    );
  }

  // ── §2 · Kill switch por tipo ──────────────────────────────────────────────
  console.log("\n§2 · Un tipo SIN cuenta no se puede aprobar");
  {
    const created = await api(
      token,
      "POST",
      svcPath,
      {
        qb_vendor_id: vendorA.id,
        vendor_display_name: vendorA.full_name,
        service_type_id: NOACCOUNT_TYPE,
        amount_cents: 9900,
      },
      E2E_PIN
    );
    check("se puede REGISTRAR el costo aunque el tipo no liquide", created.status === 200);

    const id = created.body.id as string;
    const approve = await api(
      token,
      "POST",
      `${svcPath}/services/${id}`,
      { action: "approve" },
      E2E_PIN
    );
    check(
      "aprobarlo devuelve settlement_off",
      approve.status === 409 && approve.body.code === "settlement_off",
      `status ${approve.status} code ${String(approve.body.code)}`
    );

    await api(token, "DELETE", `${svcPath}/services/${id}`, undefined, E2E_PIN);
  }

  // ── §3 · Approve congela ───────────────────────────────────────────────────
  console.log("\n§3 · Approve congela número, cuenta y monto");
  let approvedId = "";
  {
    const list = await api(token, "GET", svcPath);
    const services = (list.body.services ?? []) as Array<Record<string, unknown>>;
    const target = services.find((s) => Number(s.amount_cents) === AMOUNT);
    approvedId = String(target?.id ?? "");

    const res = await api(
      token,
      "POST",
      `${svcPath}/services/${approvedId}`,
      { action: "approve" },
      E2E_PIN
    );
    check(
      "approve devuelve el número OSV",
      res.status === 200 && String(res.body.service_number ?? "").startsWith("OSV-"),
      String(res.body.service_number ?? res.body.error ?? "")
    );

    const { rows } = await pool.query<{
      state: string;
      display_number: string | null;
      qb_account_list_id: string | null;
    }>(
      `SELECT state, display_number::text, qb_account_list_id
         FROM order_outsourced_service WHERE id = $1`,
      [approvedId]
    );
    const row = rows[0];
    check("estado = approved", row?.state === "approved", String(row?.state));
    check("número persistido", !!row?.display_number);
    check(
      "cuenta CONGELADA en la fila",
      row?.qb_account_list_id === SVC_ACCOUNT_LIST_ID,
      String(row?.qb_account_list_id)
    );

    const twice = await api(
      token,
      "POST",
      `${svcPath}/services/${approvedId}`,
      { action: "approve" },
      E2E_PIN
    );
    check("re-aprobar se rechaza", twice.status === 409, `status ${twice.status}`);

    const edit = await api(
      token,
      "POST",
      `${svcPath}/services/${approvedId}`,
      {
        action: "update",
        qb_vendor_id: vendorA.id,
        vendor_display_name: vendorA.full_name,
        service_type_id: INSTALL_TYPE,
        amount_cents: 999,
      },
      E2E_PIN
    );
    check("editar un aprobado se rechaza", edit.status === 409, `status ${edit.status}`);

    const del = await api(token, "DELETE", `${svcPath}/services/${approvedId}`, undefined, E2E_PIN);
    check("borrar un aprobado se rechaza", del.status === 409, `status ${del.status}`);
  }

  // ── §4 · Validación del vendor bill ────────────────────────────────────────
  console.log("\n§4 · El bill que liquida se valida");
  const mkBill = async (
    id: string,
    vendorId: string,
    cents: number,
    accountListId: string
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO vendor_bill (id, status, bill_type, vendor_id, document_date, created_at, updated_at)
       VALUES ($1, 'draft', 'service', $2, NOW(), NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [id, vendorId]
    );
    // `sku` y `description` son NOT NULL aun en una línea de CUENTA (la tabla
    // nació para líneas de producto). Un fixture que las omita crashea con
    // 23502 y no llega a ejercitar nada.
    await pool.query(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, qb_account_list_id, sku, description,
          qty, unit_cost_cents, created_at, updated_at)
       VALUES ($1, $2, 'qb_account', $3, '', 'E2E subcontract line', 1, $4, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [`vbl_${id}`, id, accountListId, cents]
    );
  };

  {
    await mkBill("vb_e2e_osvc_wrongvendor", vendorB.id, AMOUNT, SVC_ACCOUNT_LIST_ID);
    await mkBill("vb_e2e_osvc_wrongamount", vendorA.id, AMOUNT + 1, SVC_ACCOUNT_LIST_ID);
    await mkBill("vb_e2e_osvc_wrongaccount", vendorA.id, AMOUNT, COMM_ACCOUNT_LIST_ID);
    await mkBill("vb_e2e_osvc_good", vendorA.id, AMOUNT, SVC_ACCOUNT_LIST_ID);

    const settle = (billId: string) =>
      api(
        token,
        "POST",
        `${svcPath}/services/${approvedId}`,
        { action: "settle", vendor_bill_id: billId },
        E2E_PIN
      );

    const noBill = await api(
      token,
      "POST",
      `${svcPath}/services/${approvedId}`,
      { action: "settle" },
      E2E_PIN
    );
    check("settle sin bill se rechaza", noBill.status === 400);

    const wrongVendor = await settle("vb_e2e_osvc_wrongvendor");
    check(
      "bill de OTRO vendor se rechaza",
      wrongVendor.status === 409 && wrongVendor.body.reason === "bill_vendor_mismatch",
      String(wrongVendor.body.reason ?? wrongVendor.status)
    );

    const wrongAmount = await settle("vb_e2e_osvc_wrongamount");
    check(
      "bill con monto distinto se rechaza",
      wrongAmount.status === 409 && wrongAmount.body.reason === "bill_amount_mismatch",
      String(wrongAmount.body.reason ?? wrongAmount.status)
    );

    const wrongAccount = await settle("vb_e2e_osvc_wrongaccount");
    check(
      "bill contra la cuenta de COMISIONES se rechaza",
      wrongAccount.status === 409 && wrongAccount.body.reason === "bill_wrong_account",
      String(wrongAccount.body.reason ?? wrongAccount.status)
    );

    // El modo de falla que ninguna de las dos features ve sola.
    await pool.query(
      `INSERT INTO commission_settlement
         (id, recipient_id, method, amount_cents, vendor_bill_id, status, idempotency_key)
       SELECT 'cset_e2e_osvc_1', r.id, 'vendor_bill', $1, 'vb_e2e_osvc_good', 'pending', 'e2e-osvc-cross'
         FROM order_commission_recipient r WHERE r.deleted_at IS NULL LIMIT 1`,
      [AMOUNT]
    );
    const { rows: planted } = await pool.query(
      `SELECT 1 FROM commission_settlement WHERE id = 'cset_e2e_osvc_1'`
    );
    if (planted.length) {
      const crossClaim = await settle("vb_e2e_osvc_good");
      check(
        "un bill ya reclamado por una COMISIÓN no liquida un servicio",
        crossClaim.status === 409 && crossClaim.body.reason === "bill_claimed_by_commission",
        String(crossClaim.body.reason ?? crossClaim.status)
      );
      await pool.query(`DELETE FROM commission_settlement WHERE id = 'cset_e2e_osvc_1'`);
    } else {
      console.log(
        "  ⏭  cruce con comisiones SALTEADO — el sandbox no tiene ningún recipient de comisión para plantar el fixture"
      );
    }

    const ok = await settle("vb_e2e_osvc_good");
    check(
      "el bill correcto liquida",
      ok.status === 200 && !!ok.body.settlement_id,
      String(ok.body.error ?? ok.status)
    );

    const { rows: st } = await pool.query<{ state: string }>(
      `SELECT state FROM order_outsourced_service WHERE id = $1`,
      [approvedId]
    );
    check("estado = settling", st[0]?.state === "settling", String(st[0]?.state));

    const reuse = await settle("vb_e2e_osvc_good");
    check("re-liquidar el mismo servicio se rechaza", reuse.status === 409);
  }

  // ── §5 · Void bloqueado en settling ────────────────────────────────────────
  console.log("\n§5 · Void y sus bloqueos");
  {
    const voidSettling = await api(
      token,
      "POST",
      `${svcPath}/services/${approvedId}`,
      { action: "void", reason: "e2e cancel attempt" },
      E2E_PIN
    );
    check(
      "void desde settling se rechaza (hay un bill en vuelo)",
      voidSettling.status === 409,
      `status ${voidSettling.status}`
    );

    // Un borrador SÍ se anula, y con motivo de ≥5 chars.
    const list = await api(token, "GET", svcPath);
    const services = (list.body.services ?? []) as Array<Record<string, unknown>>;
    const draft = services.find((s) => s.state === "draft");
    const draftId = String(draft?.id ?? "");

    const shortReason = await api(
      token,
      "POST",
      `${svcPath}/services/${draftId}`,
      { action: "void", reason: "no" },
      E2E_PIN
    );
    check("un motivo corto se rechaza", shortReason.status === 400);

    const voided = await api(
      token,
      "POST",
      `${svcPath}/services/${draftId}`,
      { action: "void", reason: "subcontractor never showed up" },
      E2E_PIN
    );
    check("un borrador se anula con motivo", voided.status === 200);

    const { rows } = await pool.query<{ state: string; void_reason: string | null }>(
      `SELECT state, void_reason FROM order_outsourced_service WHERE id = $1`,
      [draftId]
    );
    check("el void CONSERVA la fila y su motivo", rows[0]?.state === "void" && !!rows[0]?.void_reason);
  }

  // ── §6 · Reconcile → posted ────────────────────────────────────────────────
  console.log("\n§6 · Reconcile: el bill asienta en QuickBooks → posted");
  {
    await pool.query(
      `UPDATE vendor_bill SET qb_txn_id = 'E2E-TXN-OSVC' WHERE id = 'vb_e2e_osvc_good'`
    );
    // El listado hace el reconcile en refresh-on-read.
    const list = await api(token, "GET", "/admin/outsourced-services?tab=closed");
    check("el listado responde", list.status === 200);

    const { rows } = await pool.query<{ state: string; settled_at: string | null }>(
      `SELECT state, settled_at::text FROM order_outsourced_service WHERE id = $1`,
      [approvedId]
    );
    check(
      "estado = posted (NO 'closed': el bill asentó, no se pagó)",
      rows[0]?.state === "posted",
      String(rows[0]?.state)
    );
    check("quedó fecha de liquidación", !!rows[0]?.settled_at);

    const { rows: sset } = await pool.query<{ status: string }>(
      `SELECT status FROM outsourced_service_settlement WHERE service_id = $1`,
      [approvedId]
    );
    check("el settlement quedó confirmed", sset[0]?.status === "confirmed", String(sset[0]?.status));

    const voidPosted = await api(
      token,
      "POST",
      `${svcPath}/services/${approvedId}`,
      { action: "void", reason: "trying to void a posted service" },
      E2E_PIN
    );
    check(
      "void desde posted se rechaza (corresponde un vendor credit)",
      voidPosted.status === 409,
      `status ${voidPosted.status}`
    );

    const closed = (list.body.rows ?? []) as Array<Record<string, unknown>>;
    check(
      "el servicio posted aparece en el tab Closed",
      closed.some((r) => r.id === approvedId)
    );
  }

  // ── §7 · Aislamiento por orden ─────────────────────────────────────────────
  console.log("\n§7 · Un servicio no se opera bajo el lock de otra orden");
  {
    const wrongOrder = await api(
      token,
      "POST",
      `/admin/outsourced-services/orders/${otherOrder.order_id}/services/${approvedId}`,
      { action: "approve" },
      E2E_PIN
    );
    check(
      "operar un servicio ajeno desde otra orden da 404",
      wrongOrder.status === 404,
      `status ${wrongOrder.status}`
    );
  }

  // ── §8 · Sin steps en el pipeline de QuickBooks ────────────────────────────
  console.log("\n§8 · La feature no encoló nada en el pipeline de QuickBooks");
  {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM qb_order_pipeline WHERE step LIKE '%outsourced%'`
    );
    check("cero filas de pipeline propias", rows[0]?.n === "0", `${rows[0]?.n} filas`);
  }

  await pool.end();

  console.log(`\n${"═".repeat(64)}`);
  console.log(`e2e-outsourced-services: ${passed} OK, ${failed} FALLARON`);
  if (failed > 0) process.exit(1);
  console.log("Todo verde.\n");
}

void main().catch((err) => {
  console.error("CRASH:", err);
  process.exit(1);
});
