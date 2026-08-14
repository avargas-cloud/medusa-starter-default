/**
 * src/scripts/tests/e2e-rounding-writeoff-sandbox.ts
 *
 * E2E del write-off de redondeo, contra el SANDBOX (nunca producción).
 *
 * Prueba lo que ningún gate estático puede probar: que la rama del write-off
 * EFECTIVAMENTE dispare dentro del route real de apply, con el módulo real de
 * Medusa y Postgres real detrás. Los nombres de método generados
 * (`createRoundingAdjustments`, …) se llaman por un cast `as any` que el
 * type-check no puede desmentir — un nombre equivocado deja la operación
 * fallando SIEMPRE, en producción, con todo en verde.
 *
 * Cada aserción positiva viene con su control: no alcanza con ver el ajuste
 * creado; hay que ver que un residuo POR ENCIMA DEL TOPE no lo cree.
 *
 * Correr:
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *   MEDUSA_BASE=http://localhost:9099 \
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-rounding-writeoff-sandbox.ts
 */

import { Client } from "pg";

const BASE = process.env.MEDUSA_BASE ?? "http://localhost:9099";
const EMAIL = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
const PASSWORD = process.env.SANDBOX_TEST_PASSWORD ?? "";
const DB =
  process.env.DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

if (!/localhost|127\.0\.0\.1/.test(DB) || !/5499/.test(DB)) {
  console.error("ABORTA: este E2E sólo corre contra el sandbox (puerto 5499).");
  console.error(`DATABASE_URL recibida: ${DB.replace(/:[^:@]+@/, ":<...>@")}`);
  process.exit(2);
}

let failures = 0;
const evidence: Record<string, unknown> = {};

function check(name: string, cond: boolean, detail = ""): boolean {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
  return cond;
}

async function api(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown }
) {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* respuesta no-JSON */
  }
  return { status: res.status, json, text };
}

async function main() {
  const pg = new Client({ connectionString: DB });
  await pg.connect();

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(" E2E — write-off de redondeo de tax (SANDBOX)");
  console.log("══════════════════════════════════════════════════════════\n");

  // ── Precondición: el mecanismo tiene que estar PRENDIDO ───────────────────
  // Un E2E que corre con el mecanismo apagado pasa en vacío: no habría ajuste
  // que crear y "no se creó ninguno" se leería como éxito del tope.
  console.log("── 0. Precondiciones");
  const login = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const loginJson: any = await login.json().catch(() => null);
  const token: string = loginJson?.token ?? "";
  if (!check("login admin del sandbox", !!token, `status ${login.status}`)) {
    await pg.end();
    process.exit(1);
  }

  // ── Reset de artefactos de corridas anteriores ────────────────────────────
  //
  // Este E2E CONSUME facturas: las salda y les cuelga un ajuste, y su propia
  // query de candidatas excluye las que ya tienen uno. Sin este reset la
  // segunda corrida se queda sin fixtures y falla por agotamiento — un test
  // que sólo funciona una vez no es un gate.
  //
  // Deshace SOLO lo suyo, identificado por el actor y las referencias que
  // escribe, y reconstruye el estado de las facturas afectadas desde las
  // aplicaciones que sobreviven. Nunca toca datos que no creó.
  // GOTCHA de Postgres: todas las sub-sentencias de un WITH ven el MISMO
  // snapshot y NO se ven entre ellas — un UPDATE hermano de un DELETE suma
  // filas que el DELETE ya borró. Por eso el reset va en DOS sentencias: primero
  // se borra, después se reconstruye leyendo lo que quedó.
  const touched = await pg.query<{ invoice_id: string }>(
    `SELECT DISTINCT invoice_id FROM payment_application
      WHERE invoice_id IS NOT NULL
        AND payment_id IN (SELECT id FROM customer_payment
                            WHERE reference LIKE 'E2E-ROUND-%' OR reference = 'E2E-OVERAGE')`
  );
  const touchedIds = touched.rows.map((r) => r.invoice_id);

  const del = await pg.query(
    `WITH mine AS (
       SELECT id FROM customer_payment
        WHERE reference LIKE 'E2E-ROUND-%' OR reference = 'E2E-OVERAGE'
     ),
     a AS (DELETE FROM pos_rounding_adjustment
            WHERE actor = 'e2e-rounding@sandbox'
               OR payment_id IN (SELECT id FROM mine) RETURNING 1),
     b AS (DELETE FROM payment_application WHERE payment_id IN (SELECT id FROM mine) RETURNING 1),
     c AS (DELETE FROM invoice_payment
            WHERE notes LIKE 'Applied from deposit/payment E2E-%' RETURNING 1),
     d AS (DELETE FROM customer_payment WHERE id IN (SELECT id FROM mine) RETURNING 1)
     SELECT (SELECT count(*) FROM a) adj, (SELECT count(*) FROM b) app,
            (SELECT count(*) FROM d) pay`
  );

  let restored = 0;
  if (touchedIds.length > 0) {
    // Ahora sí: las aplicaciones ya no existen, así que la suma refleja la verdad.
    const fixed = await pg.query(
      `UPDATE pos_invoice i
          SET amount_paid = sub.paid,
              balance_due = GREATEST(0, i.total - sub.paid),
              status = CASE WHEN i.total - sub.paid <= 0 THEN 'paid'
                            WHEN sub.paid > 0 THEN 'partial' ELSE 'issued' END
         FROM (
           SELECT x.id AS invoice_id,
                  COALESCE((SELECT SUM(pa.amount_applied) FROM payment_application pa
                             WHERE pa.invoice_id = x.id AND pa.voided_at IS NULL
                               AND pa.deleted_at IS NULL), 0)::int AS paid
             FROM pos_invoice x WHERE x.id = ANY($1)
         ) sub
        WHERE i.id = sub.invoice_id
        RETURNING i.id`,
      [touchedIds]
    );
    restored = fixed.rowCount ?? 0;
  }
  const rr = del.rows[0];
  console.log(
    `  ↺ reset: ${rr.adj} ajuste(s) · ${rr.app} aplicacion(es) · ${restored} factura(s) restaurada(s) · ${rr.pay} pago(s)`
  );

  const tableOk = await pg.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name='pos_rounding_adjustment'`
  );
  check("tabla pos_rounding_adjustment existe", tableOk.rowCount === 1);

  // ── Helper: crear pago y aplicarlo dejando `residualCents` abiertos ────────
  async function applyLeavingResidual(
    invoiceId: string,
    residualCents: number,
    label: string
  ) {
    const inv = await pg.query(
      `SELECT id, invoice_number, total, amount_paid, balance_due, status,
              customer_id, order_id
         FROM pos_invoice WHERE id = $1`,
      [invoiceId]
    );
    const invoice = inv.rows[0];
    // Se parte del SALDO, no del total: una factura elegida con pagos previos
    // haría que `total − residuo` sobrepague y el residuo resultante no sea el
    // que este caso quiere probar. (Pasó: un fixture con pagos previos puso
    // amount_paid por encima del total y tumbó 8 aserciones que no tenían nada
    // que ver con el código.)
    const applyCents = Number(invoice.balance_due) - residualCents;

    const pay = await api(token, "/admin/finance/payments", {
      method: "POST",
      body: {
        customer_id: invoice.customer_id,
        amount: applyCents,
        method: "cash",
        reference: `E2E-ROUND-${label}`,
      },
    });
    const paymentId = pay.json?.payment?.id ?? pay.json?.id;
    if (!paymentId) {
      console.log(`      no se pudo crear el pago: ${pay.status} ${pay.text.slice(0, 300)}`);
      return null;
    }

    const applied = await api(
      token,
      `/admin/finance/payments/${paymentId}/apply`,
      {
        method: "POST",
        body: {
          invoice_id: invoiceId,
          amount_applied: applyCents,
          applied_by: "e2e-rounding@sandbox",
        },
      }
    );

    const after = await pg.query(
      `SELECT status, total, amount_paid, balance_due FROM pos_invoice WHERE id=$1`,
      [invoiceId]
    );
    const adj = await pg.query(
      `SELECT id, amount_cents, direction, account_list_id, reason_code, memo,
              actor, qb_status, invoice_id, order_id
         FROM pos_rounding_adjustment
        WHERE invoice_id=$1 AND voided_at IS NULL AND deleted_at IS NULL`,
      [invoiceId]
    );

    return {
      invoice,
      paymentId,
      applyCents,
      applyStatus: applied.status,
      applyBody: applied.text.slice(0, 400),
      after: after.rows[0],
      adjustments: adj.rows,
    };
  }

  // ── 1. CAMINO POSITIVO — residuo de 1¢ se absorbe ─────────────────────────
  console.log("\n── 1. Residuo de 1¢ → se absorbe y la factura cierra");
  const target = await pg.query(
    `SELECT id FROM pos_invoice
      WHERE voided_at IS NULL AND deleted_at IS NULL
        AND status IN ('issued','partial') AND balance_due > 1000
        AND customer_id IS NOT NULL
        AND id NOT IN (SELECT invoice_id FROM pos_rounding_adjustment WHERE invoice_id IS NOT NULL)
      ORDER BY created_at DESC LIMIT 2`
  );
  if (target.rowCount! < 2) {
    console.log("  ✗ no hay 2 facturas candidatas en el sandbox");
    failures++;
    await pg.end();
    process.exit(1);
  }
  const invA = target.rows[0].id as string;
  const invB = target.rows[1].id as string;

  const r1 = await applyLeavingResidual(invA, 1, "1CENT");
  if (r1) {
    evidence.caso1 = r1;
    check("el apply respondió 200", r1.applyStatus === 200, `status ${r1.applyStatus} — ${r1.applyBody}`);
    check(
      "se creó EXACTAMENTE un ajuste",
      r1.adjustments.length === 1,
      `creados: ${r1.adjustments.length}`
    );
    // Diagnóstico, no aserción: sin las dos env vars de cuentas el mecanismo
    // NO-OPEA EN SILENCIO (es su kill switch). Sin este mensaje, un backend
    // reiniciado sin ellas —p.ej. por `./back-sb`, que no las lleva— produce
    // un rojo idéntico al de un bug de lógica y se pierden veinte minutos.
    if (r1.adjustments.length === 0 && Number(r1.after.balance_due) > 0) {
      console.log(
        "      ⚠ el pago se aplicó y quedó saldo, pero no se emitió ajuste.\n" +
        "        Causa más probable: el backend NO tiene\n" +
        "        QB_ROUNDING_SHORTAGE_ACCOUNT_LIST_ID / QB_ROUNDING_OVERAGE_ACCOUNT_LIST_ID.\n" +
        "        Verificar:  tr '\\0' '\\n' < /proc/$(lsof -ti:9099)/environ | grep QB_ROUNDING"
      );
    }
    const a = r1.adjustments[0];
    if (a) {
      check("monto = 1¢", Number(a.amount_cents) === 1, `salió ${a.amount_cents}`);
      check("dirección = shortage", a.direction === "shortage", `salió ${a.direction}`);
      check(
        "cuenta = Shortages (80000101-1454537545)",
        a.account_list_id === "80000101-1454537545",
        `salió ${a.account_list_id}`
      );
      check("motivo registrado", a.reason_code === "tax_rounding_partial_invoice");
      check(
        `memo nombra la factura (${r1.invoice.invoice_number})`,
        a.memo === `Rounding - INV ${r1.invoice.invoice_number}`,
        `salió "${a.memo}"`
      );
      check("actor registrado", a.actor === "e2e-rounding@sandbox", `salió ${a.actor}`);
      check("QB queda pendiente (no se marca éxito al encolar)", a.qb_status === "pending");
      check("memo es ASCII puro", Buffer.byteLength(String(a.memo)) === String(a.memo).length);
    }
    check(
      "la factura quedó en balance 0",
      Number(r1.after.balance_due) === 0,
      `balance_due=${r1.after.balance_due}`
    );
    check(
      "la factura quedó status=paid",
      r1.after.status === "paid",
      `status=${r1.after.status}`
    );
    // El invariante real: la plata cubre TODO menos el centavo absorbido.
    // `total − writeoff`, no `applyCents` — una factura con pagos previos hace
    // que amount_paid sea mayor que lo aplicado en ESTE request.
    check(
      "amount_paid NO incluye el centavo absorbido (no es plata que entró)",
      Number(r1.after.amount_paid) === Number(r1.after.total) - 1,
      `amount_paid=${r1.after.amount_paid} total=${r1.after.total} — esperado total−1`
    );
  }

  // ── 2. CONTROL — residuo SOBRE el tope NO se absorbe ──────────────────────
  // Sin este control, el caso 1 no prueba que el tope exista: probaría que el
  // código crea ajustes, no que sepa cuándo NO crearlos.
  console.log("\n── 2. CONTROL: residuo de 8¢ (sobre el tope de 5¢) → NO se absorbe");
  const r2 = await applyLeavingResidual(invB, 8, "8CENT");
  if (r2) {
    evidence.caso2 = r2;
    check("el apply respondió 200", r2.applyStatus === 200, `status ${r2.applyStatus}`);
    check(
      "NO se creó ningún ajuste",
      r2.adjustments.length === 0,
      `se crearon ${r2.adjustments.length}`
    );
    check(
      "la factura CONSERVA sus 8¢ de saldo",
      Number(r2.after.balance_due) === 8,
      `balance_due=${r2.after.balance_due}`
    );
    check(
      "la factura sigue 'partial', no 'paid'",
      r2.after.status === "partial",
      `status=${r2.after.status}`
    );
  }

  // ── 3. IDEMPOTENCIA — un segundo apply no duplica el ajuste ───────────────
  // Ojo con lo que este bloque prueba de verdad. Una vez absorbido el residuo la
  // factura queda en 0, así que el segundo intento no llega ni a crear el pago:
  // "sigue habiendo un solo ajuste" pasaría igual con la idempotencia ROTA.
  // Lo que sí demuestra —y es valioso— es que el write-off CUENTA COMO
  // COBERTURA: la ruta ya no ve saldo y rechaza cobrar de nuevo ese centavo,
  // que es exactamente el bug de doble cobertura que este E2E encontró.
  // La idempotencia de verdad la prueba el caso 4, contra el índice único.
  console.log("\n── 3. El write-off cuenta como cobertura: no se puede recobrar");
  const before3 = await pg.query(
    `SELECT count(*)::int c FROM pos_rounding_adjustment WHERE invoice_id=$1 AND voided_at IS NULL`,
    [invA]
  );
  const r3 = await applyLeavingResidual(invA, 1, "DUP");
  const after3 = await pg.query(
    `SELECT count(*)::int c FROM pos_rounding_adjustment WHERE invoice_id=$1 AND voided_at IS NULL`,
    [invA]
  );
  evidence.caso3 = { before: before3.rows[0].c, after: after3.rows[0].c, applyStatus: r3?.applyStatus };
  check(
    "no se creó un segundo ajuste ni se recobró el centavo",
    after3.rows[0].c === before3.rows[0].c && after3.rows[0].c === 1,
    `antes=${before3.rows[0].c} después=${after3.rows[0].c}`
  );

  // ── 4. El índice único aguanta CONCURRENCIA real ──────────────────────────
  // El código chequea antes de insertar, pero dos requests simultáneos pasan los
  // dos ese chequeo: la garantía dura la da Postgres, no el código.
  console.log("\n── 4. Concurrencia: 8 inserts simultáneos sobre la misma factura");
  const fakeInvoice = `e2e-concurrency-${Date.now()}`;
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) =>
      pg.query(
        `INSERT INTO pos_rounding_adjustment
           (id, invoice_id, amount_cents, direction, account_list_id, reason_code)
         VALUES ($1,$2,1,'shortage','80000101-1454537545','tax_rounding_partial_invoice')`,
        [`radj_e2e_${Date.now()}_${i}`, fakeInvoice]
      )
    )
  );
  const won = results.filter((r) => r.status === "fulfilled").length;
  evidence.caso4 = { intentos: 8, ganaron: won };
  check(
    "exactamente 1 de 8 inserts concurrentes gana",
    won === 1,
    `ganaron ${won} — el índice único parcial no está haciendo su trabajo`
  );
  await pg.query(`DELETE FROM pos_rounding_adjustment WHERE invoice_id=$1`, [fakeInvoice]);

  // ── 5. La ruta de lectura expone el ajuste ────────────────────────────────
  console.log("\n── 5. GET /admin/invoices/:id devuelve el ajuste");
  const read = await api(token, `/admin/invoices/${invA}`);
  evidence.caso5 = {
    status: read.status,
    rounding_adjustment_cents: read.json?.invoice?.rounding_adjustment_cents,
    rounding_adjustment: read.json?.rounding_adjustment,
  };
  check("respondió 200", read.status === 200, `status ${read.status}`);
  check(
    "invoice.rounding_adjustment_cents = 1",
    read.json?.invoice?.rounding_adjustment_cents === 1,
    `salió ${JSON.stringify(read.json?.invoice?.rounding_adjustment_cents)}`
  );
  check(
    "el objeto completo del ajuste viaja aparte",
    !!read.json?.rounding_adjustment?.id
  );
  check(
    "NO se sumó a amount_paid (sigue siendo un ajuste, no un pago)",
    Number(read.json?.invoice?.amount_paid) ===
      Number(read.json?.invoice?.total) - 1,
    `amount_paid=${read.json?.invoice?.amount_paid} total=${read.json?.invoice?.total}`
  );

  // ── 6. CONTROL de la lectura: una factura SIN ajuste devuelve 0 ───────────
  console.log("\n── 6. CONTROL: factura sin ajuste");
  const readB = await api(token, `/admin/invoices/${invB}`);
  check(
    "rounding_adjustment_cents = 0",
    readB.json?.invoice?.rounding_adjustment_cents === 0,
    `salió ${JSON.stringify(readB.json?.invoice?.rounding_adjustment_cents)}`
  );
  check("rounding_adjustment = null", readB.json?.rounding_adjustment === null);

  // ── 7. La ruta que la PANTALLA usa de verdad ──────────────────────────────
  //
  // La página de invoice arma su `activeInvoice` desde `listInvoices(orderId)`
  // — el LIST route — y NUNCA desde `/admin/invoices/:id`. Este bloque existe
  // porque la primera versión de este E2E validaba sólo el detail: el campo
  // llegaba correcto por un endpoint que la UI no consume, la fila no se
  // dibujaba, y las 27 aserciones estaban en verde. Un E2E que no pega a la
  // ruta que sirve a la pantalla no prueba que la pantalla funcione.
  console.log("\n── 7. LIST route (el que alimenta la pantalla)");
  const invARow = await pg.query(
    `SELECT order_id FROM pos_invoice WHERE id=$1`,
    [invA]
  );
  const orderId = invARow.rows[0]?.order_id;
  const list = await api(token, `/admin/invoices?order_id=${orderId}`);
  const listed = (list.json?.invoices ?? []).find((i: any) => i.id === invA);
  evidence.caso7 = {
    status: list.status,
    rounding_adjustment_cents: listed?.rounding_adjustment_cents,
  };
  check("respondió 200", list.status === 200, `status ${list.status}`);
  check("la factura aparece en la lista de su orden", !!listed);
  check(
    "el LIST trae rounding_adjustment_cents = 1",
    listed?.rounding_adjustment_cents === 1,
    `salió ${JSON.stringify(listed?.rounding_adjustment_cents)} — la fila del POS lee ESTE campo`
  );

  // CONTROL: una factura sin ajuste tiene que traer 0, no undefined. Un
  // `undefined` sería indistinguible de "el backend no manda el campo" y
  // dejaría la UI adivinando.
  const listB = await api(token, `/admin/invoices?order_id=${
    (await pg.query(`SELECT order_id FROM pos_invoice WHERE id=$1`, [invB]))
      .rows[0]?.order_id
  }`);
  const listedB = (listB.json?.invoices ?? []).find((i: any) => i.id === invB);
  check(
    "CONTROL: factura sin ajuste trae 0 explícito (no undefined)",
    listedB?.rounding_adjustment_cents === 0,
    `salió ${JSON.stringify(listedB?.rounding_adjustment_cents)}`
  );

  // ── 8. OVERAGE — la dirección espejo, construida de verdad ────────────────
  //
  // No se puede provocar "sobrepagando una factura": el route CLAMPEA. Se
  // provoca dándole al PAGO más de lo que la factura puede recibir — el clamp
  // aplica lo que corresponde y el resto queda en el pago sin destino posible.
  // Y sólo cuenta como overage si la orden ya no va a facturar más: por eso el
  // fixture es una orden TOTALMENTE facturada.
  console.log("\n── 8. OVERAGE: al pago le sobra 1¢ y la orden ya cerró");
  const ovCand = await pg.query(
    `WITH inv AS (
       SELECT order_id, sum(total) invoiced, sum(balance_due) open_bal
         FROM pos_invoice
        WHERE voided_at IS NULL AND deleted_at IS NULL AND status <> 'draft'
        GROUP BY order_id)
     SELECT i.order_id, i.open_bal,
            (SELECT id FROM pos_invoice
              WHERE order_id = i.order_id AND voided_at IS NULL AND deleted_at IS NULL
                AND status <> 'draft' AND balance_due > 0 LIMIT 1) AS invoice_id,
            (SELECT customer_id FROM pos_invoice WHERE order_id = i.order_id LIMIT 1) AS customer_id
       FROM inv i JOIN order_money_projection omp ON omp.order_id = i.order_id
      WHERE i.invoiced >= omp.order_total_cents AND omp.order_total_cents > 0
        AND i.open_bal > 100
        AND i.order_id NOT IN (SELECT order_id FROM pos_rounding_adjustment WHERE order_id IS NOT NULL)
      ORDER BY i.open_bal ASC LIMIT 1`
  );
  const ov = ovCand.rows[0];
  if (!ov?.invoice_id) {
    check("hay una orden candidata para overage", false, "ninguna orden totalmente facturada con saldo");
  } else {
    // Se paga el saldo + 1¢: el clamp aplica el saldo y el centavo queda suelto.
    const overpay = Number(ov.open_bal) + 1;
    const payOv = await api(token, "/admin/finance/payments", {
      method: "POST",
      body: {
        customer_id: ov.customer_id,
        amount: overpay,
        method: "cash",
        reference: "E2E-OVERAGE",
      },
    });
    const ovPaymentId = payOv.json?.payment?.id ?? payOv.json?.id;
    check("se creó el pago con 1¢ de más", !!ovPaymentId, payOv.text.slice(0, 200));

    if (ovPaymentId) {
      // Atribuir el pago a la orden — sin atribución el disparador se niega a
      // absorber (podría ser un depósito general del cliente).
      await pg.query(`UPDATE customer_payment SET locked_order_id=$1 WHERE id=$2`, [
        ov.order_id,
        ovPaymentId,
      ]);

      const appliedOv = await api(
        token,
        `/admin/finance/payments/${ovPaymentId}/apply`,
        {
          method: "POST",
          body: {
            invoice_id: ov.invoice_id,
            amount_applied: overpay,
            applied_by: "e2e-rounding@sandbox",
          },
        }
      );
      check("el apply respondió 200", appliedOv.status === 200, appliedOv.text.slice(0, 200));

      const invAfter = await pg.query(
        `SELECT balance_due, status FROM pos_invoice WHERE id=$1`,
        [ov.invoice_id]
      );
      check(
        "el clamp dejó la factura en 0 (no la sobrepagó)",
        Number(invAfter.rows[0]?.balance_due) === 0,
        `balance_due=${invAfter.rows[0]?.balance_due}`
      );

      const ovAdj = await pg.query(
        `SELECT amount_cents, direction, account_list_id, payment_id, invoice_id,
                order_id, memo, actor, qb_status, qb_error
           FROM pos_rounding_adjustment
          WHERE payment_id=$1 AND voided_at IS NULL`,
        [ovPaymentId]
      );
      evidence.caso8 = { ovPaymentId, orderId: ov.order_id, adjustments: ovAdj.rows };

      check("se emitió el ajuste de overage", ovAdj.rowCount === 1, `filas: ${ovAdj.rowCount}`);
      const a8 = ovAdj.rows[0];
      if (a8) {
        check("monto = 1¢", Number(a8.amount_cents) === 1, `salió ${a8.amount_cents}`);
        check("dirección = overage", a8.direction === "overage", `salió ${a8.direction}`);
        check(
          "cuenta = Overages (80000100-1454537520)",
          a8.account_list_id === "80000100-1454537520",
          `salió ${a8.account_list_id}`
        );
        check(
          "ancla el PAGO, no una factura",
          !!a8.payment_id && a8.invoice_id === null,
          `payment_id=${a8.payment_id} invoice_id=${a8.invoice_id}`
        );
        check("guarda la orden para reportar", a8.order_id === ov.order_id);
        check("memo nombra el pago", /^Rounding - PAY /.test(String(a8.memo)), `"${a8.memo}"`);
        check(
          "QB NO quedó 'confirmed' (encolar no es confirmar)",
          a8.qb_status !== "confirmed",
          `qb_status=${a8.qb_status} err=${a8.qb_error ?? "-"}`
        );
      }

      // CONTROL: el segundo intento no duplica — el índice único por pago.
      const dup = await api(
        token,
        `/admin/finance/payments/${ovPaymentId}/apply`,
        {
          method: "POST",
          body: { invoice_id: ov.invoice_id, amount_applied: 1, applied_by: "e2e" },
        }
      );
      const ovAfter = await pg.query(
        `SELECT count(*)::int c FROM pos_rounding_adjustment WHERE payment_id=$1 AND voided_at IS NULL`,
        [ovPaymentId]
      );
      check(
        "CONTROL: no se duplica el ajuste del pago",
        ovAfter.rows[0].c === 1,
        `quedaron ${ovAfter.rows[0].c} (apply devolvió ${dup.status})`
      );
    }
  }

  // ── Evidencia ─────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(" EVIDENCIA");
  console.log("══════════════════════════════════════════════════════════");
  const invNumA = (evidence.caso1 as any)?.invoice?.invoice_number;
  const invNumB = (evidence.caso2 as any)?.invoice?.invoice_number;
  // OJO con la forma del link: el parámetro de ruta es el id de la ORDEN, y la
  // factura concreta se elige con `?invoice_id=`. Pasar el id del pos_invoice
  // como parámetro de ruta abre una orden inexistente y la pantalla sale vacía
  // sin decir por qué — se perdió una vuelta entera así.
  const ordA = (evidence.caso1 as any)?.invoice?.order_id;
  const ordB = (evidence.caso2 as any)?.invoice?.order_id;
  console.log(`\n  Factura CON write-off:  #${invNumA}`);
  console.log(`    POS:  http://localhost:3099/invoices/${ordA}?invoice_id=${invA}`);
  console.log(`    API:  ${BASE}/admin/invoices?order_id=${ordA}`);
  console.log(`\n  Factura de control (8¢, sin write-off):  #${invNumB}`);
  console.log(`    POS:  http://localhost:3099/invoices/${ordB}?invoice_id=${invB}`);
  console.log(`    API:  ${BASE}/admin/invoices?order_id=${ordB}`);
  console.log(`\n  SQL de la evidencia:`);
  console.log(
    `    psql -h localhost -p 5499 -U postgres -d medusa -c "SELECT * FROM pos_rounding_adjustment;"`
  );

  await pg.end();
  console.log(
    failures === 0
      ? `\n✅ E2E VERDE — todas las aserciones pasaron\n`
      : `\n❌ E2E ROJO — ${failures} aserción(es) fallaron\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\nE2E explotó:", e);
  process.exit(1);
});
