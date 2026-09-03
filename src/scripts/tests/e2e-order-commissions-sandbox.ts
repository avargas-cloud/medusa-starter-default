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
  // Sección 13 usa un centinela PROPIO ('E2E-QB-TXN-S13') y su "control
  // positivo" final RESTAURA `deleted_at = NULL` dejando el marcador vivo —
  // la segunda corrida choca contra ÉL, no contra el de la sección 6.
  await pool.query(`UPDATE vendor_bill SET qb_txn_id = NULL WHERE qb_txn_id = 'E2E-QB-TXN-S13'`);
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
    // Búsqueda ACOTADA a un rango razonable (5%–15% de la base, bien bajo el
    // cap): si la base viva no admite ningún monto no representable ahí
    // dentro, el fixture no aplica y el check de precisión SKIPEA en vez de
    // pasar en falso (adoptando un monto que sí sería representable) o
    // fallar (culpando a una regresión que no existe).
    const searchCeiling = Math.max(2, Math.round(baseNow * 0.15));
    let candidate = Math.round(baseNow * 0.05); // 5% de la base: bien bajo el cap
    let foundImprecise = notBpsRepresentable(candidate);
    while (!foundImprecise && candidate < searchCeiling) {
      candidate += 1;
      foundImprecise = notBpsRepresentable(candidate);
    }
    const FIXED_CENTS = candidate;
    if (foundImprecise) {
      check(
        "el fixture permite probar la pérdida de precisión (monto no representable en bps)",
        true,
        `base=${baseNow} monto=${FIXED_CENTS}`
      );
    } else {
      console.log(
        `  ⚠️  SKIP: base=${baseNow} no admite un monto no representable en [5%,15%] — fixture no aplicable`
      );
    }

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
    if (foundImprecise) {
      check(
        "guardar por bps HABRÍA perdido centavos (prueba de que el modo sirve)",
        roundTrippedViaBps !== FIXED_CENTS,
        `via_bps=${roundTrippedViaBps} vs exacto=${FIXED_CENTS}`
      );
    } else {
      console.log(
        `  ⚠️  SKIP: base=${base} no admite un monto no representable — fixture no aplicable`
      );
    }

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

  // ── 9 · Un bill, un settlement (fix A) ─────────────────────────────────────
  //
  // Todas las secciones que siguen reusan el fixture principal (`resetCommission`
  // deja la orden limpia al arrancar cada una) — la invoice ya quedó backdateada
  // 31 días desde el arranque del script, así que un beneficiario nuevo pasa a
  // 'eligible' apenas se lee.
  console.log("── 9 · Un bill, un settlement (fix A) ──");
  {
    const { rows: idxRows } = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_cset_live_per_bill'`
    );
    const indexExists = idxRows.length === 1;
    check(
      "precondición: el índice uq_cset_live_per_bill existe",
      indexExists,
      indexExists ? "OK" : "AUSENTE — el resto de la sección 9 se saltea"
    );

    if (!indexExists) {
      console.log("  ⚠️  SKIP resto de la sección 9: sin el índice, el test pasaría en vacío.");
    } else {
      await resetCommission(fixture.order_id);
      const PCT_BPS_9 = 400;
      const assigned9 = await api(
        token, "POST", orderPath,
        {
          recipients: [
            { qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: PCT_BPS_9 },
            { customer_id: beneficiaryCustomer.id, display_name: "E2E S9 Benef", percent_bps: PCT_BPS_9 },
          ],
        },
        E2E_PIN
      );
      check("sección 9: asignación de 2 beneficiarios al mismo % guarda", assigned9.status === 200, `status=${assigned9.status}`);

      const got9 = await api(token, "GET", orderPath);
      const commission9 = got9.body.commission as {
        recipients: Array<{ id: string; qb_vendor_id: string | null; customer_id: string | null; state: string; amount_cents: number }>;
      } | null;
      const r1 = commission9?.recipients.find((r) => r.qb_vendor_id === vendor.id);
      const r2 = commission9?.recipients.find((r) => r.customer_id === beneficiaryCustomer.id);
      check(
        "sección 9: ambos elegibles y con el MISMO monto aprobable",
        r1?.state === "eligible" && r2?.state === "eligible" && r1?.amount_cents === r2?.amount_cents,
        `r1=${r1?.state}/${r1?.amount_cents} r2=${r2?.state}/${r2?.amount_cents}`
      );

      const approve1 = await api(token, "POST", `${orderPath}/recipients/${r1?.id}`, { action: "approve" }, E2E_PIN);
      const approve2 = await api(token, "POST", `${orderPath}/recipients/${r2?.id}`, { action: "approve" }, E2E_PIN);
      check("sección 9: approve de los dos beneficiarios OK", approve1.status === 200 && approve2.status === 200);

      const { rows: frozenAmounts } = await pool.query<{ id: string; amount_cents: string }>(
        `SELECT id, amount_cents::text FROM order_commission_recipient WHERE id = ANY($1)`,
        [[r1?.id, r2?.id]]
      );
      const amountCents9 = parseInt(String(frozenAmounts[0]?.amount_cents ?? "0"), 10);
      check(
        "sección 9: los dos montos aprobados quedaron idénticos en DB",
        frozenAmounts.length === 2 && frozenAmounts[0]?.amount_cents === frozenAmounts[1]?.amount_cents,
        JSON.stringify(frozenAmounts)
      );

      const bill9 = await api(token, "POST", "/admin/vendor-bills", {
        vendor_id: vendor.id,
        bill_type: "service",
        reference_id: `E2E-COMM-S9-${Date.now().toString(36)}`,
        initial_account_line: { qb_account_list_id: EXPENSE_LIST_ID, amount_cents: amountCents9 },
      });
      const billId9 = String((bill9.body as { vendor_bill?: { id?: string } }).vendor_bill?.id ?? bill9.body.id ?? "");
      check("sección 9: bill service por el monto exacto se crea", bill9.status === 201 || bill9.status === 200, `status=${bill9.status}`);

      const settle1 = await api(
        token, "POST", `${orderPath}/recipients/${r1?.id}`,
        { action: "settle", method: "vendor_bill", vendor_bill_id: billId9 }, E2E_PIN
      );
      check("sección 9: settle del beneficiario 1 contra el bill OK", settle1.status === 200, `status=${settle1.status}`);

      const settle2 = await api(
        token, "POST", `${orderPath}/recipients/${r2?.id}`,
        { action: "settle", method: "vendor_bill", vendor_bill_id: billId9 }, E2E_PIN
      );
      check(
        "sección 9: settle del beneficiario 2 contra el MISMO bill → 409 bill_already_settled",
        settle2.status === 409 &&
          (settle2.body.details as { reason?: string } | undefined)?.reason === "bill_already_settled",
        `status=${settle2.status} details=${JSON.stringify(settle2.body.details ?? settle2.body).slice(0, 140)}`
      );

      const { rows: noDamage } = await pool.query<{ id: string; state: string }>(
        `SELECT id, state FROM order_commission_recipient WHERE id = ANY($1)`,
        [[r1?.id, r2?.id]]
      );
      const state1 = noDamage.find((r) => r.id === r1?.id)?.state;
      const state2 = noDamage.find((r) => r.id === r2?.id)?.state;
      check(
        "sección 9: sin daño — beneficiario 1 sigue 'settling' y beneficiario 2 sigue 'approved'",
        state1 === "settling" && state2 === "approved",
        `state1=${state1} state2=${state2}`
      );
    }
  }

  // ── 10 · Un beneficiario voideado no clava la asignación (fix I) ───────────
  console.log("── 10 · Void no clava la asignación (fix I) ──");
  {
    await resetCommission(fixture.order_id);
    const assigned10 = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 100 }] },
      E2E_PIN
    );
    check("sección 10: asignación inicial (1 beneficiario) guarda", assigned10.status === 200);

    const got10a = await api(token, "GET", orderPath);
    const firstRecipientId = (got10a.body.commission as { recipients: Array<{ id: string }> } | null)
      ?.recipients[0]?.id;

    const voided10 = await api(
      token, "POST", `${orderPath}/recipients/${firstRecipientId}`,
      { action: "void", reason: "e2e sección 10" }, E2E_PIN
    );
    check("sección 10: void del único beneficiario OK", voided10.status === 200, `status=${voided10.status}`);

    const got10b = await api(token, "GET", orderPath);
    const commission10b = got10b.body.commission as { editable: boolean } | null;
    check(
      "sección 10: editable=true aunque haya un recipient en 'void'",
      commission10b?.editable === true,
      `editable=${commission10b?.editable}`
    );

    const resaved10 = await api(
      token, "POST", orderPath,
      { recipients: [{ customer_id: beneficiaryCustomer.id, display_name: "E2E S10 Nuevo Benef", percent_bps: 150 }] },
      E2E_PIN
    );
    check("sección 10: re-guardar con OTRO beneficiario → 200", resaved10.status === 200, `status=${resaved10.status}`);

    const { rows: oldRow } = await pool.query<{
      deleted_at: string | null; state: string; void_reason: string | null;
    }>(`SELECT deleted_at, state, void_reason FROM order_commission_recipient WHERE id = $1`, [firstRecipientId]);
    check(
      "sección 10: el voideado quedó deleted_at NOT NULL, state='void' y conserva su void_reason",
      oldRow[0]?.deleted_at != null && oldRow[0]?.state === "void" && oldRow[0]?.void_reason === "e2e sección 10",
      JSON.stringify(oldRow[0])
    );

    const got10c = await api(token, "GET", orderPath);
    const newRow = (got10c.body.commission as { recipients: Array<{ id: string; state: string; customer_id: string | null }> } | null)
      ?.recipients.find((r) => r.customer_id === beneficiaryCustomer.id);
    check(
      "sección 10: el nuevo beneficiario está vivo en draft/eligible",
      newRow != null && (newRow.state === "draft" || newRow.state === "eligible"),
      `state=${newRow?.state}`
    );

    // Assert extra: el DELETE de la asignación también funciona con un void presente.
    await resetCommission(fixture.order_id);
    const assigned10d = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 100 }] },
      E2E_PIN
    );
    const got10d = await api(token, "GET", orderPath);
    const rId10d = (got10d.body.commission as { recipients: Array<{ id: string }> } | null)?.recipients[0]?.id;
    await api(token, "POST", `${orderPath}/recipients/${rId10d}`, { action: "void", reason: "e2e sección 10 delete" }, E2E_PIN);
    const del10 = await api(token, "DELETE", orderPath, undefined, E2E_PIN);
    check(
      "sección 10: DELETE de la asignación funciona con un void presente",
      assigned10d.status === 200 && del10.status === 200,
      `assign=${assigned10d.status} delete=${del10.status}`
    );
    const got10e = await api(token, "GET", orderPath);
    check("sección 10: tras el DELETE la comisión desaparece", got10e.body.commission === null);
  }

  // ── 11 · El cap se re-evalúa en vivo (fix C) — LA MÁS IMPORTANTE ──────────
  console.log("── 11 · Cap dinámico: descuento vivo + void no consume cap (fix C) ──");
  {
    // Defensivo: por si una corrida anterior murió a mitad de sección.
    await pool.query(`DELETE FROM order_line_item_adjustment WHERE id = 'ordliadj_e2e_cap_11'`);
    await resetCommission(fixture.order_id);

    const money11a = await api(token, "GET", orderPath);
    const m11a = money11a.body.money as { item_subtotal_cents: number; discount_cents: number };
    const config11 = money11a.body.config as { cap_bps: number };
    const itemSubtotalCents11 = Number(m11a.item_subtotal_cents);
    const discountCents11 = Number(m11a.discount_cents);
    const capBps11 = Number(config11.cap_bps);

    const PCT_R1 = 300;
    const PCT_R2 = 200;
    const assigned11 = await api(
      token, "POST", orderPath,
      {
        recipients: [
          { qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: PCT_R1 },
          { customer_id: beneficiaryCustomer.id, display_name: "E2E S11 Benef", percent_bps: PCT_R2 },
        ],
      },
      E2E_PIN
    );
    check("sección 11: asignación DENTRO del cap guarda", assigned11.status === 200, `status=${assigned11.status}`);

    const got11a = await api(token, "GET", orderPath);
    const cap11a = got11a.body.commission as { cap_exceeded: boolean; combined_bps: number } | null;
    check(
      "sección 11: arranque dentro del cap → cap_exceeded=false",
      cap11a?.cap_exceeded === false,
      `combined_bps=${cap11a?.combined_bps} cap_bps=${capBps11}`
    );
    const combinedBpsBefore = cap11a?.combined_bps ?? 0;

    // Palanca: subir el descuento por SQL hasta pasar el cap congelado.
    const { rows: liRows11 } = await pool.query<{ item_id: string; version: number }>(
      `SELECT oi.item_id, oi.version
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id
        WHERE oi.order_id = $1 AND oi.version = o.version
        LIMIT 1`,
      [fixture.order_id]
    );
    const li11 = liRows11[0];
    if (!li11) {
      check("sección 11: SALTEADA — la orden no tiene líneas vigentes", false, "sin order_item");
    } else {
      const commissionBpsTotal11 = PCT_R1 + PCT_R2;
      const targetDiscountBps = capBps11 - commissionBpsTotal11 + 500; // margen de 5 puntos
      const targetDiscountCents = Math.max(
        discountCents11 + 1,
        Math.ceil((Math.max(0, targetDiscountBps) / 10_000) * itemSubtotalCents11)
      );
      const extraDiscountCents = Math.max(1, targetDiscountCents - discountCents11);
      const extraDiscountDollars = (extraDiscountCents / 100).toFixed(2);

      await pool.query(
        `INSERT INTO order_line_item_adjustment
           (id, item_id, amount, raw_amount, code, version, is_tax_inclusive)
         VALUES ('ordliadj_e2e_cap_11', $1, $2::numeric, jsonb_build_object('value', $2::text, 'precision', 20), 'E2E-CAP-TEST', $3, false)`,
        [li11.item_id, extraDiscountDollars, li11.version]
      );

      const got11b = await api(token, "GET", orderPath);
      const cap11b = got11b.body.commission as { cap_exceeded: boolean; combined_bps: number } | null;
      check(
        "sección 11: tras inflar el descuento → cap_exceeded=true y combined_bps > cap_bps",
        cap11b?.cap_exceeded === true && (cap11b?.combined_bps ?? 0) > capBps11,
        `combined_bps=${cap11b?.combined_bps} cap_bps=${capBps11}`
      );
      const combinedBpsAfterInflate = cap11b?.combined_bps ?? 0;

      // Tercer beneficiario insertado DIRECTO (bypassea el guard de cap del
      // POST de asignación, que a esta altura rechazaría cualquier re-guardado
      // por estar ya sobre el cap) — lo que se mide es el filtro dinámico de
      // `refreshCommission`, no la ruta de guardado.
      const { rows: commRow11 } = await pool.query<{ id: string }>(
        `SELECT id FROM order_commission WHERE order_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [fixture.order_id]
      );
      const commissionId11 = commRow11[0]?.id;
      // Identidad DISTINTA de R1/R2: `uq_ocr_vendor_live` prohíbe dos
      // recipients LIVE del mismo vendor en la misma comisión.
      const { rows: secondVendorRows } = await pool.query<{ id: string }>(
        `SELECT id FROM qb_vendor
          WHERE deleted_at IS NULL AND is_active = true AND qb_list_id NOT LIKE 'pending_%'
            AND id <> $1
          ORDER BY full_name LIMIT 1`,
        [vendor.id]
      );
      const secondVendorId = secondVendorRows[0]?.id;
      if (!secondVendorId) {
        check("sección 11: SALTEADA — no hay un segundo vendor sincronizado en el sandbox", false, "sin fixture");
      } else {
        await pool.query(
          `INSERT INTO order_commission_recipient
             (id, order_commission_id, qb_vendor_id, display_name, percent_bps, amount_mode, state)
           VALUES ('ocre_e2e_cap_void_r3', $1, $2, 'E2E S11 Void Recipient', 150, 'percent', 'draft')`,
          [commissionId11, secondVendorId]
        );

        const got11c = await api(token, "GET", orderPath);
        const cap11c = got11c.body.commission as { combined_bps: number } | null;
        check(
          "sección 11: el tercer beneficiario LIVE sí consume cap (combined_bps sube)",
          (cap11c?.combined_bps ?? 0) > combinedBpsAfterInflate,
          `before=${combinedBpsAfterInflate} conR3vivo=${cap11c?.combined_bps}`
        );

        const void11 = await api(
          token, "POST", `${orderPath}/recipients/ocre_e2e_cap_void_r3`,
          { action: "void", reason: "e2e sección 11" }, E2E_PIN
        );
        check("sección 11: void del tercer beneficiario OK", void11.status === 200, `status=${void11.status}`);

        const got11d = await api(token, "GET", orderPath);
        const cap11d = got11d.body.commission as { combined_bps: number } | null;
        check(
          "sección 11 · CHECK CRÍTICO: voideado, combined_bps vuelve EXACTO al valor sin el 3º beneficiario",
          cap11d?.combined_bps === combinedBpsAfterInflate,
          `esperado=${combinedBpsAfterInflate} obtenido=${cap11d?.combined_bps}`
        );
      }

      // Restaurar el descuento original.
      await pool.query(`DELETE FROM order_line_item_adjustment WHERE id = 'ordliadj_e2e_cap_11'`);
      const got11e = await api(token, "GET", orderPath);
      const cap11e = got11e.body.commission as { combined_bps: number } | null;
      check(
        "sección 11: descuento restaurado → combined_bps vuelve al valor de arranque",
        cap11e?.combined_bps === combinedBpsBefore,
        `esperado=${combinedBpsBefore} obtenido=${cap11e?.combined_bps}`
      );
    }
  }

  // ── 12 · Una orden cancelada no comisiona, pero SÍ se puede voidear (fix D) ─
  console.log("── 12 · Orden cancelada: no comisiona, void sigue permitido (fix D) ──");
  {
    await resetCommission(fixture.order_id);
    const { rows: statusRows } = await pool.query<{ status: string }>(
      `SELECT status FROM "order" WHERE id = $1`,
      [fixture.order_id]
    );
    const originalStatus = statusRows[0]?.status ?? "completed";

    const assigned12 = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 300 }] },
      E2E_PIN
    );
    check("sección 12: asignación inicial (orden todavía normal) guarda", assigned12.status === 200);
    const got12a = await api(token, "GET", orderPath);
    const recipientId12 = (got12a.body.commission as { recipients: Array<{ id: string }> } | null)
      ?.recipients[0]?.id;

    await pool.query(`UPDATE "order" SET status = 'canceled' WHERE id = $1`, [fixture.order_id]);

    const assignCanceled = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 100 }] },
      E2E_PIN
    );
    check(
      "sección 12: Asignar sobre orden cancelada → 409 order_not_commissionable",
      assignCanceled.status === 409 && assignCanceled.body.code === "order_not_commissionable",
      `status=${assignCanceled.status} code=${String(assignCanceled.body.code)}`
    );

    const approveCanceled = await api(
      token, "POST", `${orderPath}/recipients/${recipientId12}`, { action: "approve" }, E2E_PIN
    );
    check(
      "sección 12: Approve sobre orden cancelada → 409 order_not_commissionable",
      approveCanceled.status === 409 && approveCanceled.body.code === "order_not_commissionable",
      `status=${approveCanceled.status} code=${String(approveCanceled.body.code)}`
    );

    const settleCanceled = await api(
      token, "POST", `${orderPath}/recipients/${recipientId12}`,
      { action: "settle", method: "store_credit" }, E2E_PIN
    );
    check(
      "sección 12: Settle sobre orden cancelada → 409 order_not_commissionable",
      settleCanceled.status === 409 && settleCanceled.body.code === "order_not_commissionable",
      `status=${settleCanceled.status} code=${String(settleCanceled.body.code)}`
    );

    const voidCanceled = await api(
      token, "POST", `${orderPath}/recipients/${recipientId12}`,
      { action: "void", reason: "e2e sección 12 — orden cancelada" }, E2E_PIN
    );
    check(
      "sección 12: Void sobre orden cancelada → 200 (SIGUE PERMITIDO)",
      voidCanceled.status === 200,
      `status=${voidCanceled.status}`
    );

    await pool.query(`UPDATE "order" SET status = $2 WHERE id = $1`, [fixture.order_id, originalStatus]);

    const assignedRestored = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 150 }] },
      E2E_PIN
    );
    check(
      "sección 12: CONTROL POSITIVO — restaurado el status, la asignación vuelve a funcionar",
      assignedRestored.status === 200,
      `status=${assignedRestored.status} orderStatusRestaurado=${originalStatus}`
    );
  }

  // ── 13 · Un bill soft-borrado no cierra el settlement (fix E) ──────────────
  console.log("── 13 · Bill soft-borrado no cierra el settlement (fix E) ──");
  {
    await resetCommission(fixture.order_id);
    const assigned13 = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 350 }] },
      E2E_PIN
    );
    check("sección 13: asignación guarda", assigned13.status === 200);
    const got13a = await api(token, "GET", orderPath);
    const recipientId13 = (got13a.body.commission as { recipients: Array<{ id: string }> } | null)
      ?.recipients[0]?.id;

    const approve13 = await api(token, "POST", `${orderPath}/recipients/${recipientId13}`, { action: "approve" }, E2E_PIN);
    check("sección 13: approve OK", approve13.status === 200);

    const { rows: amt13 } = await pool.query<{ amount_cents: string }>(
      `SELECT amount_cents::text FROM order_commission_recipient WHERE id = $1`,
      [recipientId13]
    );
    const amountCents13 = parseInt(String(amt13[0]?.amount_cents ?? "0"), 10);

    const bill13 = await api(token, "POST", "/admin/vendor-bills", {
      vendor_id: vendor.id,
      bill_type: "service",
      reference_id: `E2E-COMM-S13-${Date.now().toString(36)}`,
      initial_account_line: { qb_account_list_id: EXPENSE_LIST_ID, amount_cents: amountCents13 },
    });
    const billId13 = String((bill13.body as { vendor_bill?: { id?: string } }).vendor_bill?.id ?? bill13.body.id ?? "");
    check("sección 13: bill service se crea", bill13.status === 201 || bill13.status === 200, `status=${bill13.status}`);

    const settle13 = await api(
      token, "POST", `${orderPath}/recipients/${recipientId13}`,
      { action: "settle", method: "vendor_bill", vendor_bill_id: billId13 }, E2E_PIN
    );
    check("sección 13: settle vendor_bill → settling", settle13.status === 200, `status=${settle13.status}`);

    // Soft-borrar el bill Y darle un qb_txn_id (simula: confirmó en QB y
    // alguien lo borró después). El índice único es parcial
    // (`WHERE deleted_at IS NULL`), así que setear las dos columnas en la
    // MISMA sentencia no colisiona con nada.
    await pool.query(
      `UPDATE vendor_bill SET deleted_at = NOW(), qb_txn_id = 'E2E-QB-TXN-S13' WHERE id = $1`,
      [billId13]
    );

    await api(token, "GET", "/admin/commissions?tab=open"); // dispara reconcile-on-read

    const readState13 = async (): Promise<{ state: string | null; settlementStatus: string | null }> => {
      const { rows } = await pool.query<{ state: string; status: string }>(
        `SELECT r.state, s.status
           FROM order_commission_recipient r
           JOIN commission_settlement s ON s.recipient_id = r.id
          WHERE r.id = $1
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT 1`,
        [recipientId13]
      );
      return { state: rows[0]?.state ?? null, settlementStatus: rows[0]?.status ?? null };
    };

    const afterSoftDelete = await readState13();
    check(
      "sección 13: bill soft-borrado → el settlement NO cierra (sigue 'settling'/no confirmado)",
      afterSoftDelete.state === "settling" && afterSoftDelete.settlementStatus !== "confirmed",
      JSON.stringify(afterSoftDelete)
    );

    // CONTROL POSITIVO: restaurar el bill y disparar el reconcile de nuevo —
    // ahora SÍ tiene que cerrar. Sin esto, "no cerró" es compatible con "el
    // reconcile no corrió".
    await pool.query(`UPDATE vendor_bill SET deleted_at = NULL WHERE id = $1`, [billId13]);
    await api(token, "GET", "/admin/commissions?tab=open");
    const afterRestore = await readState13();
    check(
      "sección 13: CONTROL POSITIVO — restaurado el bill, el reconcile SÍ cierra",
      afterRestore.state === "closed" && afterRestore.settlementStatus === "confirmed",
      JSON.stringify(afterRestore)
    );
  }

  console.log("── 14 (2026-09-03) · PRIMER invoice manda + approve temprano + bill con fecha/ref ──");
  {
    const CLONE_INVOICE_ID = "e2e_inv_min_14";
    // Corrida previa pudo dejar el clon: limpiarlo ANTES de medir nada.
    await pool.query(`DELETE FROM pos_invoice WHERE id = $1`, [CLONE_INVOICE_ID]);

    const readRecipient = async (): Promise<{
      id: string; state: string; eligible_at: string | null;
    } | null> => {
      const got = await api(token, "GET", orderPath);
      const c = got.body.commission as {
        recipients: Array<{ id: string; state: string; eligible_at: string | null }>;
      } | null;
      return c?.recipients[0] ?? null;
    };

    // a. Base: asignación fresca sobre el fixture (facturas a -31d) → eligible.
    await resetCommission(fixture.order_id);
    const assigned14 = await api(
      token, "POST", orderPath,
      { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 300 }] },
      E2E_PIN
    );
    check("sección 14: asignación guarda", assigned14.status === 200);
    let r14 = await readRecipient();
    check("sección 14: factura de -31d → eligible", r14?.state === "eligible", `state=${r14?.state}`);

    // Customer EFECTIVO (delta v4): el beneficiario se asignó por VENDOR
    // (customer_id crudo NULL), pero el link inverso existe (lo creó la
    // sección 5) → el listado tiene que servir el customer resuelto, que es
    // lo que habilita Store Credit en el SettleModal. Antes servía el crudo
    // y la pantalla decía "no linked customer account" con el link vivo.
    {
      const list14 = await api(token, "GET", "/admin/commissions?tab=open");
      const rows14 =
        (list14.body as {
          rows?: Array<{ recipient_id: string; customer_id: string | null; qb_vendor_id: string | null }>;
        }).rows ?? [];
      const listRow = rows14.find((x) => x.recipient_id === r14?.id);
      check(
        "sección 14: listado sirve customer EFECTIVO vía link inverso (beneficiario vendor-only)",
        listRow?.customer_id === beneficiaryCustomer.id && listRow?.qb_vendor_id === vendor.id,
        `customer_id=${listRow?.customer_id ?? "null"}`
      );
    }

    // b. MIN vs MAX — aparece una SEGUNDA factura HOY (clon de la primera).
    //    Con el MAX viejo, el próximo refresh reiniciaba la espera y el
    //    beneficiario caía eligible→draft; con MIN la espera corre desde la
    //    PRIMERA factura y el estado NO se mueve. Discrimina de verdad: este
    //    check falla si se revierte el MIN.
    await pool.query(
      `CREATE TEMP TABLE tmp_e2e_inv_14 AS
        SELECT * FROM pos_invoice
         WHERE order_id = $1 AND deleted_at IS NULL AND status NOT IN ('draft','voided')
         ORDER BY created_at ASC LIMIT 1`,
      [fixture.order_id]
    );
    await pool.query(
      `UPDATE tmp_e2e_inv_14
          SET id = $1, invoice_number = 'E2E-MIN-14', created_at = NOW(), updated_at = NOW()`,
      [CLONE_INVOICE_ID]
    );
    await pool.query(`INSERT INTO pos_invoice SELECT * FROM tmp_e2e_inv_14`);
    await pool.query(`DROP TABLE tmp_e2e_inv_14`);
    try {
      r14 = await readRecipient();
      check(
        "sección 14: una factura NUEVA no reinicia la espera (MIN — sigue eligible)",
        r14?.state === "eligible",
        `state=${r14?.state}`
      );
      const got14 = await api(token, "GET", orderPath);
      const money14 = got14.body.money as { first_invoice_at: string | null } | null;
      const firstInvoiceAgeDays = money14?.first_invoice_at
        ? (Date.now() - new Date(money14.first_invoice_at).getTime()) / 86_400_000
        : null;
      check(
        "sección 14: money.first_invoice_at es la factura VIEJA (~31d), no la de hoy",
        firstInvoiceAgeDays !== null && firstInvoiceAgeDays > 25,
        `age=${firstInvoiceAgeDays?.toFixed(1)}d`
      );
    } finally {
      await pool.query(`DELETE FROM pos_invoice WHERE id = $1`, [CLONE_INVOICE_ID]);
    }

    // c. Approve TEMPRANO. Facturas a -5d → el devengo queda DETERMINADO pero
    //    futuro: el refresh deja al beneficiario en draft con eligible_at.
    await resetCommission(fixture.order_id);
    await pool.query(
      `UPDATE pos_invoice SET created_at = NOW() - INTERVAL '5 days'
        WHERE order_id = $1 AND deleted_at IS NULL AND status NOT IN ('draft','voided')`,
      [fixture.order_id]
    );
    try {
      const assigned14c = await api(
        token, "POST", orderPath,
        { recipients: [{ qb_vendor_id: vendor.id, display_name: vendor.full_name, percent_bps: 300 }] },
        E2E_PIN
      );
      check("sección 14c: asignación guarda", assigned14c.status === 200);
      r14 = await readRecipient();
      const eligibleFuture =
        !!r14?.eligible_at && new Date(r14.eligible_at).getTime() > Date.now();
      check(
        "sección 14c: factura de -5d → draft con eligible_at FUTURO (devengo determinado)",
        r14?.state === "draft" && eligibleFuture,
        `state=${r14?.state} eligible_at=${r14?.eligible_at}`
      );

      const noEarly = await api(
        token, "POST", `${orderPath}/recipients/${r14?.id}`,
        { action: "approve" }, E2E_PIN
      );
      check(
        "sección 14c: approve SIN early → 409 (la espera no venció)",
        noEarly.status === 409,
        `status=${noEarly.status}`
      );

      const early = await api(
        token, "POST", `${orderPath}/recipients/${r14?.id}`,
        { action: "approve", early: true }, E2E_PIN
      );
      check("sección 14c: approve CON early → 200", early.status === 200, JSON.stringify(early.body).slice(0, 80));
      const { rows: earlyRows } = await pool.query<{
        state: string; before_eligible: boolean;
      }>(
        `SELECT state, (approved_at < eligible_at) AS before_eligible
           FROM order_commission_recipient WHERE id = $1`,
        [r14?.id]
      );
      check(
        "sección 14c: approved en DB, y la traza queda sola (approved_at < eligible_at)",
        earlyRows[0]?.state === "approved" && earlyRows[0]?.before_eligible === true,
        JSON.stringify(earlyRows[0])
      );

      // d. El bill del settle acepta fecha y referencia PROPIAS (lo que el
      //    SettleModal ahora manda) y el settle lo valida y linkea igual.
      const { rows: amtRows } = await pool.query<{ amount_cents: string }>(
        `SELECT amount_cents::text FROM order_commission_recipient WHERE id = $1`,
        [r14?.id]
      );
      const amount14 = parseInt(String(amtRows[0]?.amount_cents ?? "0"), 10);
      const REF_14 = `E2E-COMM-S14-${Date.now().toString(36)}`;
      const DOC_DATE_14 = new Date("2026-08-15T12:00:00").toISOString();
      const bill14 = await api(token, "POST", "/admin/vendor-bills", {
        vendor_id: vendor.id,
        bill_type: "service",
        reference_id: REF_14,
        document_date: DOC_DATE_14,
        initial_account_line: { qb_account_list_id: EXPENSE_LIST_ID, amount_cents: amount14 },
      });
      const billId14 = String(
        (bill14.body as { vendor_bill?: { id?: string } }).vendor_bill?.id ?? ""
      );
      check(
        "sección 14d: bill service con document_date + ref custom se crea",
        (bill14.status === 200 || bill14.status === 201) && !!billId14,
        `status=${bill14.status}`
      );
      const { rows: billRows } = await pool.query<{ reference_id: string | null; same_day: boolean }>(
        `SELECT reference_id, (document_date::date = $2::date) AS same_day
           FROM vendor_bill WHERE id = $1`,
        [billId14, DOC_DATE_14]
      );
      check(
        "sección 14d: el bill PERSISTIÓ la fecha y la referencia elegidas",
        billRows[0]?.reference_id === REF_14 && billRows[0]?.same_day === true,
        JSON.stringify(billRows[0])
      );
      const settle14 = await api(
        token, "POST", `${orderPath}/recipients/${r14?.id}`,
        { action: "settle", method: "vendor_bill", vendor_bill_id: billId14 }, E2E_PIN
      );
      check(
        "sección 14d: settle valida y linkea el bill con fecha/ref propias → settling",
        settle14.status === 200,
        `status=${settle14.status} ${JSON.stringify(settle14.body).slice(0, 80)}`
      );
    } finally {
      // Repetibilidad: el fixture vuelve a su forma canónica (-31d) pase lo que pase.
      await pool.query(
        `UPDATE pos_invoice SET created_at = NOW() - INTERVAL '31 days'
          WHERE order_id = $1 AND deleted_at IS NULL AND status NOT IN ('draft','voided')`,
        [fixture.order_id]
      );
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
