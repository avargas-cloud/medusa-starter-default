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
  opts: { token: string; body?: Record<string, unknown>; method?: string }
): Promise<Resp> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
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
  } finally {
    await cleanup(db);
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
