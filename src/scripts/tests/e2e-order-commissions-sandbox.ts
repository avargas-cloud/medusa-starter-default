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
 * REPETIBLE, con una condición: dejar ≥60s entre corridas. El script resetea lo
 * que vive en la DB (comisión, settlements, link customer↔vendor, el qb_txn_id
 * centinela del bill, y las 4 cuentas de comisión del store), pero
 * `lib/commissions/config.ts` cachea la config EN EL PROCESO del servidor con
 * TTL de 60s: borrar las cuentas por SQL no invalida esa memoria, así que una
 * segunda corrida inmediata ve el settle habilitado y la aserción "sin cuentas
 * configuradas → settlement_off" falla por el cache, no por una regresión.
 * Medido: corrida inmediata 54/55, corrida a los 65s 55/55.
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

  /**
   * Borra la comisión de una orden para dejarla asignable de nuevo.
   *
   * Hace falta por DOS motivos, y los dos son propiedades reales del dominio:
   *  1. Esta orden está paga y facturada hace 31 días, así que el beneficiario
   *     salta de draft a ELIGIBLE en el primer GET — y `canReSaveAssignment`
   *     sólo deja re-guardar mientras todos estén en draft. O sea que sobre
   *     este fixture cada guardado real necesita partir de cero.
   *  2. Una corrida anterior deja beneficiarios approved/settled y entonces la
   *     segunda corrida reporta fallas que no son regresiones. Un E2E que no se
   *     puede correr dos veces no sirve de gate.
   */
  const resetCommission = async (orderId: string): Promise<void> => {
    const { rows: prior } = await pool.query<{ id: string }>(
      `SELECT r.id
         FROM order_commission_recipient r
         JOIN order_commission c ON c.id = r.order_commission_id
        WHERE c.order_id = $1`,
      [orderId]
    );
    if (prior.length > 0) {
      const ids = prior.map((r) => r.id);
      await pool.query(`DELETE FROM commission_settlement WHERE recipient_id = ANY($1)`, [ids]);
      await pool.query(`DELETE FROM order_commission_recipient WHERE id = ANY($1)`, [ids]);
    }
    await pool.query(`DELETE FROM order_commission WHERE order_id = $1`, [orderId]);
  };


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

  await resetCommission(fixture.order_id);
  // El link customer↔vendor es único por identidad: si sobrevive de una corrida
  // anterior, la sección 5 falla al crearlo con "already linked".
  await pool.query(
    `DELETE FROM customer_vendor_link WHERE customer_id = $1 OR qb_vendor_id = $2`,
    [beneficiaryCustomer.id, vendor.id]
  );
  // La sección 6 estampa un qb_txn_id CENTINELA en el bill que crea; hay índice
  // único sobre esa columna, así que la segunda corrida explota con 23505 antes
  // de llegar a ninguna aserción.
  await pool.query(`UPDATE vendor_bill SET qb_txn_id = NULL WHERE qb_txn_id = 'E2E-QB-TXN'`);
  // La sección 4 afirma que SIN cuentas configuradas el settle está apagado,
  // pero después las configura y nunca las saca: en la segunda corrida esa
  // afirmación no se puede ejercer. Se quitan las 4 claves (sólo esas — borrar
  // el metadata entero se llevaría el PIN de supervisor).
  await pool.query(
    `UPDATE store
        SET metadata = metadata
              - 'qb_commission_expense_account'
              - 'qb_commission_expense_account_name'
              - 'qb_commission_clearing_account'
              - 'qb_commission_clearing_account_name'
      WHERE metadata IS NOT NULL`
  );

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

  // ── 1b · MONTO FIJO ────────────────────────────────────────────────────────
  //
  // Va ANTES de la asignación definitiva porque re-guardar sólo se permite
  // mientras todos los beneficiarios estén en draft; después del settle la
  // asignación queda clavada (eso lo prueba la sección 7).
  console.log("── 1b · Monto fijo: el centavo exacto, y el cap ──");
  {
    // El monto se DIMENSIONA contra la base real del fixture: una constante
    // fija ($500) supera el cap en una orden chica y el test mediría el
    // rechazo del cap creyendo que mide otra cosa.
    const money0 = await api(token, "GET", orderPath);
    const m = money0.body.money as { item_subtotal_cents: number; discount_cents: number };
    const baseNow = Math.max(0, Number(m.item_subtotal_cents) - Number(m.discount_cents));

    // Además se elige un monto que NO sea representable en bps sobre esta base
    // — si lo fuera, el control de precisión pasaría en vacío.
    const notBpsRepresentable = (cents: number): boolean => {
      const bps = Math.round((cents / baseNow) * 10_000);
      return Math.round((baseNow * bps) / 10_000) !== cents;
    };
    let candidate = Math.round(baseNow * 0.05); // 5% de la base: bien bajo el cap
    for (let i = 0; i < 200 && !notBpsRepresentable(candidate); i++) candidate += 1;
    const FIXED_CENTS = candidate;
    check(
      "el fixture permite probar la pérdida de precisión (monto no representable en bps)",
      notBpsRepresentable(FIXED_CENTS),
      `base=${baseNow} monto=${FIXED_CENTS}`
    );

    const savedFixed = await api(
      token, "POST", orderPath,
      {
        recipients: [
          {
            qb_vendor_id: vendor.id,
            display_name: vendor.full_name,
            amount_mode: "fixed",
            fixed_amount_cents: FIXED_CENTS,
          },
        ],
      },
      E2E_PIN
    );
    check("asignación por monto fijo guarda", savedFixed.status === 200, `status=${savedFixed.status}`);

    const got = await api(token, "GET", orderPath);
    const commission = got.body.commission as {
      base_cents: number;
      recipients: Array<{
        id: string;
        amount_cents: number;
        percent_bps: number;
        amount_mode: string;
        fixed_amount_cents: number | null;
      }>;
    } | null;
    const fixedRow = commission?.recipients[0];

    check(
      "el monto vuelve al CENTAVO EXACTO (no degradado por bps)",
      fixedRow?.amount_cents === FIXED_CENTS,
      `esperado=${FIXED_CENTS} obtenido=${fixedRow?.amount_cents}`
    );
    check("la fila recuerda su modo", fixedRow?.amount_mode === "fixed", String(fixedRow?.amount_mode));
    check(
      "fixed_amount_cents persiste como la verdad de la fila",
      fixedRow?.fixed_amount_cents === FIXED_CENTS,
      String(fixedRow?.fixed_amount_cents)
    );

    // El % que devuelve es DERIVADO de la base vigente, no un valor guardado.
    const base = commission?.base_cents ?? 0;
    const expectedBps = Math.round((FIXED_CENTS / base) * 10_000);
    check(
      "el % se DERIVA del monto sobre la base vigente",
      fixedRow?.percent_bps === expectedBps,
      `base=${base} esperado=${expectedBps}bps obtenido=${fixedRow?.percent_bps}bps`
    );

    // CONTROL NEGATIVO del propio test: si el monto fijo se hubiera guardado
    // convirtiéndolo a bps (la vía vieja), volvería redondeado a la resolución
    // del bp. Este assert falla si alguien reintroduce esa conversión.
    const roundTrippedViaBps = Math.round((base * expectedBps) / 10_000);
    check(
      "guardar por bps HABRÍA perdido centavos (prueba de que el modo sirve)",
      roundTrippedViaBps !== FIXED_CENTS,
      `via_bps=${roundTrippedViaBps} vs exacto=${FIXED_CENTS}`
    );

    // ── El monto fijo NO puede saltear el cap ────────────────────────────────
    // Un monto que supera el cap se convierte a su % efectivo y se rechaza,
    // igual que un porcentaje directo.
    const capCents = Math.round((base * 9_999) / 10_000);
    const overCapFixed = await api(
      token, "POST", orderPath,
      {
        recipients: [
          {
            qb_vendor_id: vendor.id,
            display_name: vendor.full_name,
            amount_mode: "fixed",
            fixed_amount_cents: capCents,
          },
        ],
      },
      E2E_PIN
    );
    check(
      "un monto fijo por encima del cap se RECHAZA (no es vía de escape)",
      overCapFixed.status === 400 && overCapFixed.body.code === "cap_exceeded",
      `status=${overCapFixed.status} code=${String(overCapFixed.body.code)}`
    );

    // ── Validación de entrada en la RUTA ─────────────────────────────────────
    for (const [label, value] of [
      ["cero", 0],
      ["negativo", -100],
      ["con centavos fraccionarios", 500.5],
    ] as Array<[string, number]>) {
      const bad = await api(
        token, "POST", orderPath,
        {
          recipients: [
            {
              qb_vendor_id: vendor.id,
              display_name: vendor.full_name,
              amount_mode: "fixed",
              fixed_amount_cents: value,
            },
          ],
        },
        E2E_PIN
      );
      check(`la ruta rechaza un monto fijo ${label}`, bad.status === 400, `status=${bad.status}`);
    }

    const badMode = await api(
      token, "POST", orderPath,
      {
        recipients: [
          { qb_vendor_id: vendor.id, display_name: vendor.full_name, amount_mode: "whatever", percent_bps: 100 },
        ],
      },
      E2E_PIN
    );
    check("la ruta rechaza un amount_mode desconocido", badMode.status === 400, `status=${badMode.status}`);

    // ── Compatibilidad hacia atrás ───────────────────────────────────────────
    // Un caller que no manda amount_mode (todo lo anterior a este cambio) sigue
    // guardando por porcentaje, sin tocar nada.
    await resetCommission(fixture.order_id);
    const legacy = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 250 }] },
      E2E_PIN
    );
    check("un payload SIN amount_mode sigue guardando por %", legacy.status === 200, `status=${legacy.status}`);
    const gotLegacy = await api(token, "GET", orderPath);
    const legacyRow = (gotLegacy.body.commission as {
      base_cents: number;
      recipients: Array<{ amount_mode: string; percent_bps: number; amount_cents: number }>;
    } | null)?.recipients[0];
    check(
      "esa fila queda en modo 'percent' y deriva su monto de la base",
      legacyRow?.amount_mode === "percent" &&
        legacyRow?.percent_bps === 250 &&
        legacyRow?.amount_cents === Math.round(((gotLegacy.body.commission as { base_cents: number }).base_cents * 250) / 10_000),
      `mode=${legacyRow?.amount_mode} bps=${legacyRow?.percent_bps} amount=${legacyRow?.amount_cents}`
    );
  }

  // ── 1c · La afirmación de fondo: quién sigue a la orden y quién no ─────────
  //
  // Una fila por % se ajusta sola cuando cambia la orden (§2.3: una devolución
  // achica la comisión). Una fila FIJA no. Se prueban las DOS en la misma
  // orden y en el mismo cambio de base, porque la de % es el CONTROL POSITIVO:
  // si la palanca no movió la base de verdad, ella tampoco se mueve y el test
  // falla — en vez de pasar en vacío afirmando algo que nunca se ejerció.
  console.log("── 1c · Cambio de base: la fija no se mueve, la de % sí ──");
  {
    const PCT_BPS = 300;
    // Igual que en 1b: el monto se dimensiona contra la base real, y además
    // tiene que entrar en el cap JUNTO con el 3% de la otra fila.
    const money1 = await api(token, "GET", orderPath);
    const m1 = money1.body.money as { item_subtotal_cents: number; discount_cents: number };
    const base1 = Math.max(0, Number(m1.item_subtotal_cents) - Number(m1.discount_cents));
    const FIXED_CENTS = Math.max(1, Math.round(base1 * 0.05));

    await resetCommission(fixture.order_id);
    await api(
      token, "POST", orderPath,
      {
        recipients: [
          { qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: PCT_BPS },
          {
            customer_id: beneficiaryCustomer.id,
            display_name: "E2E Fixed Benef",
            amount_mode: "fixed",
            fixed_amount_cents: FIXED_CENTS,
          },
        ],
      },
      E2E_PIN
    );

    type Row = { qb_vendor_id: string | null; amount_cents: number; amount_mode: string };
    const readRows = async (): Promise<{ base: number; pct?: Row; fix?: Row }> => {
      const g = await api(token, "GET", orderPath);
      const c = g.body.commission as { base_cents: number; recipients: Row[] } | null;
      return {
        base: c?.base_cents ?? 0,
        pct: c?.recipients.find((r) => r.amount_mode === "percent"),
        fix: c?.recipients.find((r) => r.amount_mode === "fixed"),
      };
    };

    const before = await readRows();
    check(
      "arranque: la fija vale su monto y la de % vale base × bps",
      before.fix?.amount_cents === FIXED_CENTS &&
        before.pct?.amount_cents === Math.round((before.base * PCT_BPS) / 10_000),
      `base=${before.base} fija=${before.fix?.amount_cents} pct=${before.pct?.amount_cents}`
    );

    // Palanca: subir 10% el precio de las líneas de la orden. Se restaura al
    // final del bloque; se guarda el valor original para no adivinarlo.
    const { rows: liRows } = await pool.query<{ id: string; unit_price: string }>(
      `SELECT DISTINCT li.id, li.unit_price::text
         FROM order_item oi
         JOIN order_line_item li ON li.id = oi.item_id
        WHERE oi.order_id = $1`,
      [fixture.order_id]
    );
    try {
      for (const li of liRows) {
        const bumped = Number(li.unit_price) * 1.1;
        // La columna numérica Y su gemela raw_ (BigNumber) se mueven JUNTAS.
        await pool.query(
          // $2 se castea explícito en los DOS usos: sin eso Postgres no puede
          // deducir un tipo único ("inconsistent types deduced", text vs numeric).
          `UPDATE order_line_item
              SET unit_price = $2::numeric,
                  raw_unit_price = jsonb_set(raw_unit_price, '{value}', to_jsonb($2::numeric::text))
            WHERE id = $1`,
          [li.id, bumped]
        );
      }

      const after = await readRows();

      check(
        "CONTROL POSITIVO: la base cambió de verdad",
        after.base !== before.base,
        `${before.base} → ${after.base}`
      );
      check(
        "CONTROL POSITIVO: la fila por % SIGUIÓ a la orden",
        after.pct?.amount_cents !== before.pct?.amount_cents &&
          after.pct?.amount_cents === Math.round((after.base * PCT_BPS) / 10_000),
        `${before.pct?.amount_cents} → ${after.pct?.amount_cents}`
      );
      check(
        "la fila FIJA no se movió un centavo",
        after.fix?.amount_cents === FIXED_CENTS,
        `${before.fix?.amount_cents} → ${after.fix?.amount_cents} (esperado ${FIXED_CENTS})`
      );
    } finally {
      for (const li of liRows) {
        await pool.query(
          // $2 se castea explícito en los DOS usos: sin eso Postgres no puede
          // deducir un tipo único ("inconsistent types deduced", text vs numeric).
          `UPDATE order_line_item
              SET unit_price = $2::numeric,
                  raw_unit_price = jsonb_set(raw_unit_price, '{value}', to_jsonb($2::numeric::text))
            WHERE id = $1`,
          [li.id, Number(li.unit_price)]
        );
      }
    }

    const restored = await readRows();
    check(
      "la orden quedó como estaba (base restaurada)",
      restored.base === before.base,
      `base=${restored.base}`
    );
  }

  console.log("── 2 · Asignación válida + devengo ──");
  let recipientVendorId = "";
  let recipientCustomerId = "";
  {
    // Las secciones de monto fijo dejaron su propia asignación: el flujo
    // original arranca de cero, igual que si corriera solo.
    await resetCommission(fixture.order_id);
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

  // ── 8 · Approve de una fila FIJA congela el centavo exacto ────────────────
  //
  // Es el número que termina pagándose, así que se prueba contra el servidor y
  // no sólo en la unidad. Va sobre OTRA orden: la del fixture principal quedó
  // con la asignación clavada después del settle.
  console.log("── 8 · Approve de un monto fijo congela el centavo exacto ──");
  {
    const { rows: second } = await pool.query<{ order_id: string; customer_id: string; display_id: string }>(
      `SELECT o.id AS order_id, o.customer_id, o.display_id::text
         FROM "order" o
         JOIN order_money_projection omp ON omp.order_id = o.id
         JOIN pos_invoice pi ON pi.order_id = o.id
          AND pi.deleted_at IS NULL AND pi.status NOT IN ('draft','voided')
        WHERE o.deleted_at IS NULL
          AND o.customer_id IS NOT NULL
          AND o.id <> $1
          -- Base > $100: por debajo de eso 1 bp vale menos de un centavo, o sea
          -- que TODO monto es representable y la pérdida de precisión —lo que
          -- esta sección existe para medir— no puede ocurrir.
          AND omp.order_total_cents > 20000
          AND omp.applied_cents + omp.deposit_cents >= omp.order_total_cents
          AND NOT EXISTS (
            SELECT 1 FROM order_commission oc
             WHERE oc.order_id = o.id AND oc.deleted_at IS NULL
          )
        ORDER BY o.created_at DESC
        LIMIT 1`,
      [fixture.order_id]
    );
    const other = second[0];
    if (!other) {
      // Nunca se saltea en silencio: un test ausente que no se anuncia se lee
      // como un test que pasó.
      check("SALTEADA: el sandbox no tiene una 2ª orden paga sin comisión", false, "sin fixture");
    } else {
      await pool.query(
        `UPDATE pos_invoice SET created_at = NOW() - INTERVAL '31 days'
          WHERE order_id = $1 AND deleted_at IS NULL AND status NOT IN ('draft','voided')`,
        [other.order_id]
      );
      const otherPath = `/admin/commissions/orders/${other.order_id}`;
      const money2 = await api(token, "GET", otherPath);
      const m2 = money2.body.money as { item_subtotal_cents: number; discount_cents: number };
      const base2 = Math.max(0, Number(m2.item_subtotal_cents) - Number(m2.discount_cents));
      // Monto elegido para NO ser representable en bps sobre esta base: es lo
      // que hace que "congelar por modo" sea distinguible de "reconstruir".
      const notRepr = (c: number): boolean =>
        Math.round((base2 * Math.round((c / base2) * 10_000)) / 10_000) !== c;
      // La búsqueda se ACOTA al 10% de la base: sin tope, sobre una base chica
      // (donde ningún monto pierde precisión) el bucle escala hasta pasar el
      // cap y el test falla por una razón que no es la que mide.
      const ceiling = Math.max(2, Math.round(base2 * 0.1));
      let odd = Math.max(1, Math.round(base2 * 0.05));
      while (odd < ceiling && !notRepr(odd)) odd += 1;
      const ODD_CENTS = notRepr(odd) ? odd : Math.max(1, Math.round(base2 * 0.05));
      check(
        "el fixture de la sección 8 permite medir la pérdida de precisión",
        notRepr(ODD_CENTS),
        `base=${base2} monto=${ODD_CENTS}`
      );

      const saved = await api(
        token, "POST", otherPath,
        {
          recipients: [
            {
              qb_vendor_id: vendor.id,
              display_name: vendor.full_name,
              amount_mode: "fixed",
              fixed_amount_cents: ODD_CENTS,
            },
          ],
        },
        E2E_PIN
      );
      check(
        `asignación fija sobre la orden ${other.display_id}`,
        saved.status === 200,
        `status=${saved.status} base=${base2} monto=${ODD_CENTS} body=${JSON.stringify(saved.body).slice(0, 140)}`
      );

      const got = await api(token, "GET", otherPath);
      const c = got.body.commission as {
        base_cents: number;
        recipients: Array<{ id: string; state: string; amount_cents: number }>;
      } | null;
      const row = c?.recipients[0];
      check("la fila quedó eligible (pagada + 31d)", row?.state === "eligible", `state=${row?.state}`);

      if (row) {
        const approved = await api(
          token, "POST", `${otherPath}/recipients/${row.id}`, { action: "approve" }, E2E_PIN
        );
        check("approve responde OK", approved.status === 200, `status=${approved.status}`);

        const { rows: frozen } = await pool.query<{ amount_cents: string; amount_mode: string; state: string }>(
          `SELECT amount_cents::text, amount_mode, state
             FROM order_commission_recipient WHERE id = $1`,
          [row.id]
        );
        check(
          "el monto CONGELADO en la DB es el centavo exacto tipeado",
          Number(frozen[0]?.amount_cents) === ODD_CENTS,
          `esperado=${ODD_CENTS} guardado=${frozen[0]?.amount_cents}`
        );
        check("el modo sobrevive al approve", frozen[0]?.amount_mode === "fixed", String(frozen[0]?.amount_mode));

        // Lo que habría pasado reconstruyendo desde bps: la prueba de que
        // congelar POR MODO no es un detalle cosmético.
        const viaBps = Math.round(
          ((c?.base_cents ?? 0) * Math.round((ODD_CENTS / (c?.base_cents || 1)) * 10_000)) / 10_000
        );
        check(
          "reconstruir desde bps HABRÍA congelado otro número",
          viaBps !== ODD_CENTS,
          `via_bps=${viaBps} vs exacto=${ODD_CENTS}`
        );
      }

      // Limpieza: esta orden no participa del resto del sistema.
      await pool.query(
        `UPDATE order_commission_recipient SET deleted_at = NOW()
          WHERE order_commission_id IN (SELECT id FROM order_commission WHERE order_id = $1)`,
        [other.order_id]
      );
      await pool.query(`UPDATE order_commission SET deleted_at = NOW() WHERE order_id = $1`, [other.order_id]);
    }
  }

  await pool.end();
  console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed · ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
