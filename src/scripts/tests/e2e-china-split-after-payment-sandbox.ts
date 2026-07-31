/**
 * E2E — split de un bill de China Finance que YA tiene plata confirmada — SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * `verify-china-finance-split-payment.ts` llama a `splitBillForPartialPayment`
 * directamente, con un `pg.Client` adaptado a mano. Eso prueba la aritmética y no
 * prueba la RUTA, que es por donde entra el operador.
 *
 * Y la ruta tiene una forma de fallar que ningún gate estático ve: resuelve
 * `__pg_connection__` con un cast a un tipo `Knex` declarado localmente, que el
 * type-check no puede desmentir. Si ese cast queda mal, cada split explota en
 * producción con `yarn type-check` en verde. Por eso acá no alcanza con
 * comprobar que un pedido inválido dé 400 — un cast roto también daría error.
 * Lo que prueba algo es que un split LEGÍTIMO sea ACEPTADO y que el efecto ocurra.
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  1. CONTROL POSITIVO: un parcial genuino sobre un bill con pago confirmado
 *     SÍ parte, por HTTP, con 200 — y la raíz queda en `confirmado + pagado
 *     ahora`, no en `pagado ahora`. Sin este caso, el punto 2 lo cumpliría una
 *     ruta que rechaza todo.
 *  2. LA REGRESIÓN (VB-1053): un bill pagado entero y después corregido HACIA
 *     ARRIBA. Pagar lo que quedó abierto no difiere nada → 400, una sola fila,
 *     importe intacto y las dos aplicaciones sin tocar.
 *  3. Pedir MÁS que el saldo abierto → 400 (es un merge/crédito, no un split).
 *  4. Las aplicaciones CONFIRMADAS nunca se reescriben en ningún camino.
 *
 * QuickBooks no se toca: esta ruta no encola nada, y en el sandbox el bridge
 * está apagado igual.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-china-split-after-payment-sandbox.ts
 */
import { Client } from "pg";

// ── Guards fail-closed ───────────────────────────────────────────────────────
// Este script SIEMBRA bills y wires. El snapshot del sandbox trae los mismos ids
// que producción, así que el destino no se infiere: se exige.
const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

/** Prefijo único de todo lo que este test crea — hace el cleanup trivial e idempotente. */
const TAG = "_e2e_cfsplit_";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(
    `BASE apunta a ${BASE}. Este script SOLO corre contra el backend sandbox en ` +
      `localhost:9099 — siembra bills y wires.`
  );
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(
    `la DB no es la del sandbox (se esperaba localhost:5499). Sembrar bills de ` +
      `china-finance en la base equivocada es exactamente lo que este guard impide.`
  );
}

// ── Mini framework ───────────────────────────────────────────────────────────
const results: Array<{ ok: boolean; name: string; detail: string }> = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

interface Resp {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}
async function call(
  path: string,
  opts: { token: string; body?: Record<string, unknown>; method?: string; pin?: string }
): Promise<Resp> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };
  // Editar un bill ya pagado por un wire CONFIRMADO exige PIN de supervisor
  // (409 `on_confirmed_wire` sin él). Es el gate real del flujo: así se editó
  // VB-1053 en producción, y un test que no lo mande no está probando el camino
  // que recorre el operador.
  if (opts.pin !== undefined) headers["x-supervisor-pin"] = opts.pin;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* respuesta no-JSON: `raw` queda para el diagnóstico */
  }
  return { status: res.status, body, raw };
}

interface BillRow {
  id: string;
  amount_cents: number;
  split_group_id: string | null;
  partial_seq: number | null;
}

/** Todas las filas del grupo de un bill, ordenadas por parcial. */
async function groupRows(db: Client, rootId: string): Promise<BillRow[]> {
  const { rows } = await db.query<BillRow>(
    `SELECT id, amount_cents, split_group_id, partial_seq
       FROM china_finance_bill
      WHERE id = $1 OR split_group_id = $1
      ORDER BY partial_seq NULLS FIRST, id`,
    [rootId]
  );
  return rows;
}

/** `applied_cents` de una aplicación puntual — para afirmar que NO se movió. */
async function appliedOf(db: Client, appId: string): Promise<number | null> {
  const { rows } = await db.query<{ applied_cents: number }>(
    `SELECT applied_cents FROM china_wire_transfer_application WHERE id = $1`,
    [appId]
  );
  return rows[0]?.applied_cents ?? null;
}

async function cleanup(db: Client): Promise<void> {
  // Orden inverso a las dependencias. Son filas propias del test, creadas con
  // ids que llevan el TAG: un DELETE por prefijo no puede alcanzar nada ajeno.
  // Los hijos de un split NACEN con id aleatorio (randomUUID), así que se
  // alcanzan por su `split_group_id`, que sí lleva el TAG.
  await db.query(`DELETE FROM china_wire_transfer_application WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM china_finance_bill WHERE split_group_id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM china_finance_bill WHERE id LIKE $1`, [`%${TAG}%`]);
  await db.query(`DELETE FROM china_wire_transfer WHERE id LIKE $1`, [`%${TAG}%`]);
}

/**
 * Siembra un bill con UNA aplicación confirmada y UNA draft.
 * Devuelve los ids para poder afirmar sobre cada fila por separado.
 */
async function seedBill(
  db: Client,
  key: string,
  opts: { amountCents: number; confirmedCents: number; draftCents: number; invoice: string }
): Promise<{ billId: string; confirmedAppId: string; draftAppId: string }> {
  const billId = `cfb${TAG}${key}`;
  const wireC = `cwc${TAG}${key}`;
  const wireD = `cwd${TAG}${key}`;
  const appC = `apc${TAG}${key}`;
  const appD = `apd${TAG}${key}`;

  await db.query(
    `INSERT INTO china_finance_bill
       (id, type, sort_order, document_type, invoice_number, payee, amount_cents, document_date, due_date)
     VALUES ($1,'vendor_bill',900,'commercial_invoice',$2,'E2E Agent',$3,'2026-07-06','2026-07-27')`,
    [billId, opts.invoice, opts.amountCents]
  );
  await db.query(
    `INSERT INTO china_wire_transfer (id, status, sent_date, confirmed_date, wire_amount_cents)
     VALUES ($1,'confirmed','2026-07-27','2026-07-27',$2)`,
    [wireC, opts.confirmedCents]
  );
  await db.query(
    `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order)
     VALUES ($1,$2,$3,$4,0)`,
    [appC, wireC, billId, opts.confirmedCents]
  );
  await db.query(
    `INSERT INTO china_wire_transfer (id, status, wire_amount_cents) VALUES ($1,'draft',$2)`,
    [wireD, opts.draftCents]
  );
  await db.query(
    `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order)
     VALUES ($1,$2,$3,$4,0)`,
    [appD, wireD, billId, opts.draftCents]
  );
  return { billId, confirmedAppId: appC, draftAppId: appD };
}

/**
 * Un PO con una línea, para colgarle las líneas de vendor bill.
 *
 * `PATCH /admin/vendor-bills/:id/lines/:lineId` capea la cantidad contra la
 * línea de PO y rechaza con `no_po_line` si no la encuentra — o sea que sin esto
 * el Save nunca llega al recompute y el test mediría otra cosa.
 *
 * Los ids obligatorios (vendor, location, variante, inventory item) se COPIAN de
 * filas reales del sandbox en vez de inventarse: son claves foráneas, y un valor
 * inventado falla con un error de integridad que se lee como un bug del código.
 */
async function seedPoLine(db: Client, key: string): Promise<string> {
  const poId = `po${TAG}${key}`;
  const polId = `pol${TAG}${key}`;
  const { rows: src } = await db.query<{
    vendor_id: string;
    stock_location_id: string;
    created_by_user_id: string;
  }>(
    `SELECT vendor_id, stock_location_id, created_by_user_id
       FROM purchase_order
      WHERE vendor_id IS NOT NULL AND stock_location_id IS NOT NULL
      ORDER BY id LIMIT 1`
  );
  const { rows: srcLine } = await db.query<{
    product_variant_id: string;
    inventory_item_id: string;
  }>(
    `SELECT product_variant_id, inventory_item_id
       FROM purchase_order_line
      WHERE product_variant_id IS NOT NULL AND inventory_item_id IS NOT NULL
      ORDER BY id LIMIT 1`
  );
  if (!src[0] || !srcLine[0]) {
    abort(
      "el sandbox no tiene ningún purchase_order/purchase_order_line del que copiar " +
        "las claves foráneas. ¿Se restauró el snapshot?"
    );
  }
  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id, created_by_user_id)
     VALUES ($1,$2,$3,$4)`,
    [poId, src[0].vendor_id, src[0].stock_location_id, src[0].created_by_user_id]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id, sku_snapshot,
        description_snapshot, qty_ordered, unit_cost_cents, total_cents)
     VALUES ($1,$2,$3,$4,'E2E-SKU','e2e fixture',99,100000,9900000)`,
    [polId, poId, srcLine[0].product_variant_id, srcLine[0].inventory_item_id]
  );
  return polId;
}

async function main(): Promise<void> {
  console.log("\nE2E — china-finance split sobre un bill con pago confirmado (sandbox)\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  // El índice UNIQUE(bill_id) viejo impide sembrar dos aplicaciones por bill, que
  // es la premisa entera de este test. Producción ya no lo tiene (migración
  // 1782000000000); un sandbox restaurado desde un dump anterior sí.
  const { rows: idxRows } = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname = 'idx_cwta_bill_once'`
  );
  if (idxRows.length > 0) {
    await db.end();
    abort(
      `este sandbox todavía tiene 'idx_cwta_bill_once', que hace imposible que un ` +
        `bill tenga dos aplicaciones. Correr las migraciones (o DROP INDEX a mano) ` +
        `antes de este test — si no, todo fallaría por el schema y no por el código.`
    );
  }

  await cleanup(db);

  // ── Login ──────────────────────────────────────────────────────────────────
  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
  if (!auth.token) {
    await db.end();
    abort(
      `no se pudo loguear como ${email} (HTTP ${authRes.status}). Ver la sección ` +
        `de usuario de test en docs/SANDBOX.md — un reset del sandbox lo borra.`
    );
  }
  const token = auth.token;

  // El PIN vive en la tienda y NO se imprime nunca. Sin él, los dos casos que
  // tocan un bill pagado responden 409 y el test mediría el gate en vez de la
  // lógica que dice medir.
  const { rows: pinRows } = await db.query<{ pin: string | null }>(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store LIMIT 1`
  );
  const supervisorPin = pinRows[0]?.pin ?? undefined;
  if (!supervisorPin) {
    await db.end();
    abort(
      "el sandbox no tiene PIN de supervisor configurado (store.metadata.pos_supervisor_pin). " +
        "Sin él no se puede editar un bill pagado, que es la mitad de este test."
    );
  }
  console.log(`  · PIN de supervisor: presente (${supervisorPin.length} dígitos, no se imprime)`);

  try {
    // ── 1. CONTROL POSITIVO ────────────────────────────────────────────────
    // Bill de $1.000,00 · $600,00 ya confirmados · se pagan $150,00 en el draft.
    // Abierto = $400,00 → se difiere $250,00. La raíz debe quedar en $750,00
    // (confirmado + pagado ahora), NUNCA en $150,00.
    console.log("1. Parcial genuino sobre plata confirmada (control positivo)");
    const ok = await seedBill(db, "ok", {
      amountCents: 100000,
      confirmedCents: 60000,
      draftCents: 15000,
      invoice: "E2E-SPLIT-OK",
    });
    const okRes = await call(`/admin/china-finance/bills/${ok.billId}/split`, {
      token,
      body: { pay_now_cents: 15000 },
    });
    check(
      "la ruta ACEPTA un split legítimo (200)",
      okRes.status === 200,
      `HTTP ${okRes.status}: ${okRes.raw.slice(0, 240)}`
    );
    const okRows = await groupRows(db, ok.billId);
    const okRoot = okRows.find((r) => r.id === ok.billId);
    const okChild = okRows.find((r) => r.id !== ok.billId);
    check("quedan 2 parciales", okRows.length === 2, `hay ${okRows.length}`);
    check(
      "raíz = confirmado + pagado ahora ($750,00), no $150,00",
      okRoot?.amount_cents === 75000,
      `raíz en ${okRoot?.amount_cents}`
    );
    check(
      "hija = saldo - pagado ($250,00)",
      okChild?.amount_cents === 25000,
      `hija en ${okChild?.amount_cents}`
    );
    check(
      "el total del grupo se conserva ($1.000,00)",
      (okRoot?.amount_cents ?? 0) + (okChild?.amount_cents ?? 0) === 100000,
      `suma ${(okRoot?.amount_cents ?? 0) + (okChild?.amount_cents ?? 0)}`
    );
    check(
      "la aplicación CONFIRMADA no se movió ($600,00)",
      (await appliedOf(db, ok.confirmedAppId)) === 60000,
      `quedó en ${await appliedOf(db, ok.confirmedAppId)}`
    );
    check(
      "la aplicación DRAFT quedó en lo pagado ahora ($150,00)",
      (await appliedOf(db, ok.draftAppId)) === 15000,
      `quedó en ${await appliedOf(db, ok.draftAppId)}`
    );

    // ── 2. LA REGRESIÓN ────────────────────────────────────────────────────
    // VB-1053 al centavo: pagado entero ($3.763,37) y después corregido hacia
    // arriba ($3.775,15). Los $11,78 abiertos son TODO lo que se debe.
    console.log("\n2. Bill pagado entero y corregido hacia arriba (la regresión)");
    const reg = await seedBill(db, "reg", {
      amountCents: 377515,
      confirmedCents: 376337,
      draftCents: 1178,
      invoice: "E2E-SPLIT-REG",
    });
    const regRes = await call(`/admin/china-finance/bills/${reg.billId}/split`, {
      token,
      body: { pay_now_cents: 1178 },
    });
    check(
      "pagar todo el saldo abierto es RECHAZADO (400)",
      regRes.status === 400,
      `HTTP ${regRes.status}: ${regRes.raw.slice(0, 240)}`
    );
    check(
      "el rechazo explica que no hay nada que diferir",
      /nothing to split/i.test(regRes.raw),
      `mensaje: ${regRes.raw.slice(0, 240)}`
    );
    const regRows = await groupRows(db, reg.billId);
    check("sigue habiendo UNA sola fila", regRows.length === 1, `hay ${regRows.length}`);
    check(
      "el importe quedó intacto ($3.775,15) y sin partir",
      regRows[0]?.amount_cents === 377515 &&
        regRows[0]?.split_group_id === null &&
        regRows[0]?.partial_seq === null,
      `fila: ${JSON.stringify(regRows[0])}`
    );
    check(
      "no apareció ningún crédito falso: confirmado ($3.763,37) intacto",
      (await appliedOf(db, reg.confirmedAppId)) === 376337,
      `quedó en ${await appliedOf(db, reg.confirmedAppId)}`
    );
    check(
      "la aplicación draft de $11,78 sigue en pie",
      (await appliedOf(db, reg.draftAppId)) === 1178,
      `quedó en ${await appliedOf(db, reg.draftAppId)}`
    );

    // ── 3. Pedir MÁS que el saldo abierto ──────────────────────────────────
    console.log("\n3. Pedir más que el saldo abierto");
    const over = await seedBill(db, "over", {
      amountCents: 50000,
      confirmedCents: 40000,
      draftCents: 5000,
      invoice: "E2E-SPLIT-OVER",
    });
    const overRes = await call(`/admin/china-finance/bills/${over.billId}/split`, {
      token,
      body: { pay_now_cents: 20000 }, // abierto = 10000
    });
    check(
      "un pago mayor al saldo abierto es RECHAZADO (400)",
      overRes.status === 400,
      `HTTP ${overRes.status}: ${overRes.raw.slice(0, 240)}`
    );
    const overRows = await groupRows(db, over.billId);
    check(
      "no se partió ni se movió nada",
      overRows.length === 1 && overRows[0]?.amount_cents === 50000,
      `filas: ${JSON.stringify(overRows)}`
    );
    check(
      "la aplicación confirmada sigue en $400,00",
      (await appliedOf(db, over.confirmedAppId)) === 40000,
      `quedó en ${await appliedOf(db, over.confirmedAppId)}`
    );
    // ── 4. EL FLUJO REAL: editar un bill pagado y que se parta SOLO ─────────
    // Sin botón y sin curl a una ruta especial. El operador abre un vendor bill
    // que ya se pagó, corrige una cantidad, guarda — y el ledger pasa a mostrar
    // los dos registros. Esto va por `PATCH /admin/vendor-bills/:id/lines/:lineId`,
    // que es la ruta que él toca de verdad, no por la lib.
    console.log("\n4. Editar hacia arriba un bill PAGADO (auto-split por el Save)");
    const vbId = `vb${TAG}auto`;
    const vlId = `vl${TAG}auto`;
    const cfbId = `cfb${TAG}auto`;
    const wcId = `cwc${TAG}auto`;
    await db.query(
      `INSERT INTO vendor_bill (id, status, bill_type, document_date, reference_id)
       VALUES ($1,'draft','regular','2026-07-06','E2E-PI-'||$1)`,
      [vbId]
    );
    const autoPol = await seedPoLine(db, "auto");
    await db.query(`UPDATE vendor_bill SET purchase_order_id = $1 WHERE id = $2`, [`po${TAG}auto`, vbId]);
    await db.query(
      `INSERT INTO vendor_bill_line (id, vendor_bill_id, purchase_order_line_id, sku, description, unit_cost_cents, qty)
       VALUES ($1,$2,$3,'E2E-AUTO','auto-split e2e',100000,1)`,
      [vlId, vbId, autoPol]
    );
    await db.query(
      `INSERT INTO china_finance_bill
         (id, type, sort_order, vendor_bill_id, document_type, invoice_number, payee,
          amount_cents, document_date, due_date)
       VALUES ($1,'vendor_bill',950,$2,'commercial_invoice','E2E-AUTO','E2E Agent',100000,'2026-07-06','2026-07-27')`,
      [cfbId, vbId]
    );
    await db.query(
      `INSERT INTO china_wire_transfer (id, status, sent_date, confirmed_date, wire_amount_cents)
       VALUES ($1,'confirmed','2026-07-20','2026-07-20',100000)`,
      [wcId]
    );
    await db.query(
      `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order)
       VALUES ($1,$2,$3,100000,0)`,
      [`apc${TAG}auto`, wcId, cfbId]
    );

    const beforeRows = await groupRows(db, cfbId);
    check(
      "control: antes del Save hay UNA sola fila",
      beforeRows.length === 1,
      `hay ${beforeRows.length}`
    );

    // qty 1 → 2 duplica el total: 1000.00 → 2000.00, con 1000.00 ya pagados.
    // Por el PATCH del BILL COMPLETO, no por la ruta por línea: esa rechaza todo
    // bill pagado sin escape (`on_confirmed_wire`), mientras que ESTA acepta el
    // PIN de supervisor y audita el ajuste. Es la puerta por la que se editó
    // VB-1053 en producción. El PIN viaja en el BODY, no en un header.
    const editRes = await call(`/admin/vendor-bills/${vbId}`, {
      token,
      method: "PATCH",
      body: {
        supervisor_pin: supervisorPin,
        lines: [
          {
            id: vlId,
            purchase_order_line_id: autoPol,
            qty: 2,
            unit_cost_cents: 100000,
            sku: "E2E-AUTO",
            description: "auto-split e2e",
          },
        ],
      },
    });
    check(
      "el Save del bill responde 200",
      editRes.status === 200,
      `HTTP ${editRes.status}: ${editRes.raw.slice(0, 240)}`
    );

    const autoRows = await groupRows(db, cfbId);
    check("el Save partió el bill SOLO (2 registros)", autoRows.length === 2, `hay ${autoRows.length}`);
    check(
      "Partial #1 = lo ya pagado ($1,000.00)",
      autoRows[0]?.amount_cents === 100000,
      `quedó en ${autoRows[0]?.amount_cents}`
    );
    check(
      "Partial #2 = lo que ahora falta ($1,000.00)",
      autoRows[1]?.amount_cents === 100000,
      `quedó en ${autoRows[1]?.amount_cents}`
    );
    check(
      "el grupo suma el nuevo total del documento ($2,000.00)",
      (autoRows[0]?.amount_cents ?? 0) + (autoRows[1]?.amount_cents ?? 0) === 200000,
      `suma ${(autoRows[0]?.amount_cents ?? 0) + (autoRows[1]?.amount_cents ?? 0)}`
    );
    check(
      "la aplicación confirmada NO se tocó ($1,000.00)",
      (await appliedOf(db, `apc${TAG}auto`)) === 100000,
      `quedó en ${await appliedOf(db, `apc${TAG}auto`)}`
    );
    // ── 5. Bill SIN PAGAR: el monto se actualiza y el wire draft lo sigue ───
    // El caso corriente. No hay plata confirmada, así que no se parte nada: el
    // espejo toma el monto nuevo y la reserva del wire draft se mueve con él,
    // hacia arriba o hacia abajo.
    console.log("\n5. Bill SIN PAGAR editado: el wire draft sigue el monto");
    const uPol = await seedPoLine(db, "unpaid");
    const uVb = `vb${TAG}unpaid`, uVl = `vl${TAG}unpaid`, uCfb = `cfb${TAG}unpaid`, uWd = `cwd${TAG}unpaid`;
    await db.query(`INSERT INTO vendor_bill (id, status, bill_type, document_date, reference_id)
       VALUES ($1,'draft','regular','2026-07-06','E2E-PI-'||$1)`, [uVb]);
    await db.query(
      `INSERT INTO vendor_bill_line (id, vendor_bill_id, purchase_order_line_id, sku, description, unit_cost_cents, qty)
       VALUES ($1,$2,$3,'E2E-UNPAID','unpaid e2e',50000,2)`,
      [uVl, uVb, uPol]
    );
    await db.query(
      `INSERT INTO china_finance_bill (id, type, sort_order, vendor_bill_id, document_type, invoice_number, payee, amount_cents, document_date, due_date)
       VALUES ($1,'vendor_bill',951,$2,'commercial_invoice','E2E-UNPAID','E2E Agent',100000,'2026-07-06','2026-07-27')`,
      [uCfb, uVb]
    );
    await db.query(`UPDATE vendor_bill SET purchase_order_id = $1 WHERE id = $2`, [`po${TAG}unpaid`, uVb]);
    await db.query(`INSERT INTO china_wire_transfer (id, status, wire_amount_cents) VALUES ($1,'draft',100000)`, [uWd]);
    await db.query(
      `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order) VALUES ($1,$2,$3,100000,0)`,
      [`apd${TAG}unpaid`, uWd, uCfb]
    );

    const upRes = await call(`/admin/vendor-bills/${uVb}/lines/${uVl}`, { token, method: "PATCH", body: { qty: 3 } });
    check("sin pagar · el Save responde 200", upRes.status === 200, `HTTP ${upRes.status}: ${upRes.raw.slice(0, 200)}`);
    const uRows = await groupRows(db, uCfb);
    check("sin pagar · NO se parte (sigue habiendo 1 registro)", uRows.length === 1, `hay ${uRows.length}`);
    check("sin pagar · el monto sube a $1,500.00", uRows[0]?.amount_cents === 150000, `quedó en ${uRows[0]?.amount_cents}`);
    check("sin pagar · la reserva del wire draft SIGUE al monto", (await appliedOf(db, `apd${TAG}unpaid`)) === 150000, `quedó en ${await appliedOf(db, `apd${TAG}unpaid`)}`);

    const downRes = await call(`/admin/vendor-bills/${uVb}/lines/${uVl}`, { token, method: "PATCH", body: { qty: 1 } });
    check("sin pagar · el Save hacia ABAJO responde 200", downRes.status === 200, `HTTP ${downRes.status}: ${downRes.raw.slice(0, 200)}`);
    const uDown = await groupRows(db, uCfb);
    check("sin pagar · el monto baja a $500.00 y sigue sin partirse", uDown.length === 1 && uDown[0]?.amount_cents === 50000, `filas ${uDown.length}, monto ${uDown[0]?.amount_cents}`);
    check("sin pagar · la reserva baja con él", (await appliedOf(db, `apd${TAG}unpaid`)) === 50000, `quedó en ${await appliedOf(db, `apd${TAG}unpaid`)}`);

    // ── 6. Bill PAGADO editado hacia ABAJO: nace un crédito ────────────────
    // La otra mitad de la simetría. Pagamos de más, así que el excedente queda
    // a nuestro favor — y aparece SOLO, sin que nadie apriete nada. Lo que sigue
    // siendo decisión del operador es a qué wire aplicarlo.
    console.log("\n6. Bill PAGADO editado hacia ABAJO: aparece el crédito");
    const cPol = await seedPoLine(db, "credit");
    const cVb = `vb${TAG}credit`, cVl = `vl${TAG}credit`, cCfb = `cfb${TAG}credit`, cWc = `cwc${TAG}credit`;
    await db.query(`INSERT INTO vendor_bill (id, status, bill_type, document_date, reference_id)
       VALUES ($1,'draft','regular','2026-07-06','E2E-PI-'||$1)`, [cVb]);
    await db.query(
      `INSERT INTO vendor_bill_line (id, vendor_bill_id, purchase_order_line_id, sku, description, unit_cost_cents, qty)
       VALUES ($1,$2,$3,'E2E-CREDIT','credit e2e',100000,2)`,
      [cVl, cVb, cPol]
    );
    await db.query(
      `INSERT INTO china_finance_bill (id, type, sort_order, vendor_bill_id, document_type, invoice_number, payee, amount_cents, document_date, due_date)
       VALUES ($1,'vendor_bill',952,$2,'commercial_invoice','E2E-CREDIT','E2E Agent',200000,'2026-07-06','2026-07-27')`,
      [cCfb, cVb]
    );
    await db.query(
      `INSERT INTO china_wire_transfer (id, status, sent_date, confirmed_date, wire_amount_cents) VALUES ($1,'confirmed','2026-07-20','2026-07-20',200000)`,
      [cWc]
    );
    await db.query(`UPDATE vendor_bill SET purchase_order_id = $1 WHERE id = $2`, [`po${TAG}credit`, cVb]);
    await db.query(
      `INSERT INTO china_wire_transfer_application (id, wire_transfer_id, bill_id, applied_cents, sort_order) VALUES ($1,$2,$3,200000,0)`,
      [`apc${TAG}credit`, cWc, cCfb]
    );

    const credRes = await call(`/admin/vendor-bills/${cVb}`, {
      token,
      method: "PATCH",
      body: {
        supervisor_pin: supervisorPin,
        lines: [
          {
            id: cVl,
            purchase_order_line_id: cPol,
            qty: 1,
            unit_cost_cents: 100000,
            sku: "E2E-CREDIT",
            description: "credit e2e",
          },
        ],
      },
    });
    check("sobrepago · el Save responde 200", credRes.status === 200, `HTTP ${credRes.status}: ${credRes.raw.slice(0, 200)}`);
    const cRows = await groupRows(db, cCfb);
    check("sobrepago · NO se parte (pagar de más no crea deuda)", cRows.length === 1, `hay ${cRows.length}`);
    check("sobrepago · el monto baja a $1,000.00", cRows[0]?.amount_cents === 100000, `quedó en ${cRows[0]?.amount_cents}`);
    check("sobrepago · la aplicación CONFIRMADA no se tocó ($2,000.00)", (await appliedOf(db, `apc${TAG}credit`)) === 200000, `quedó en ${await appliedOf(db, `apc${TAG}credit`)}`);

    // El crédito no es una fila que alguien inserta: se DERIVA de que lo aplicado
    // supere al monto. Se lo preguntamos al endpoint que alimenta la pantalla.
    const billsRes = await call("/admin/china-finance/bills", { token, method: "GET" });
    const usable = (billsRes.body.usable_credits ?? []) as Array<{ source_bill_id: string; available_cents: number }>;
    const mine = usable.find((u) => u.source_bill_id === cCfb);
    check(
      "sobrepago · el crédito de $1,000.00 aparece SOLO como aplicable a un wire",
      mine?.available_cents === 100000,
      mine ? `apareció con ${mine.available_cents}` : "no apareció en usable_credits"
    );
  } finally {
    // `china_finance_bill.vendor_bill_id` tiene FK al vendor bill: los espejos
    // salen PRIMERO o el DELETE del bill choca contra la constraint. Y las
    // líneas de vendor bill apuntan a la línea de PO, así que el PO va último.
    await cleanup(db);
    await db.query(`DELETE FROM vendor_bill_line WHERE id LIKE $1`, [`%${TAG}%`]);
    await db.query(`DELETE FROM vendor_bill WHERE id LIKE $1`, [`%${TAG}%`]);
    await db.query(`DELETE FROM purchase_order_line WHERE id LIKE $1`, [`%${TAG}%`]);
    await db.query(`DELETE FROM purchase_order WHERE id LIKE $1`, [`%${TAG}%`]);
    const { rows: leftovers } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM china_finance_bill
        WHERE id LIKE $1 OR split_group_id LIKE $1`,
      [`%${TAG}%`]
    );
    check(
      "cleanup: el test no dejó ninguna fila atrás",
      Number(leftovers[0]?.n ?? "0") === 0,
      `quedaron ${leftovers[0]?.n}`
    );
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${results.length - failed.length}/${results.length}\n`
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main();
