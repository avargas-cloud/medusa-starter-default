/**
 * E2E de los gates de PIN de supervisor — SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * `verify-pin-enforcement.ts` es estático: lee texto y comprueba que ninguna ruta
 * compare el PIN a mano y que las rutas de dinero llamen al guard. No puede
 * probar que el guard FUNCIONE.
 *
 * Y la forma en que fallaría es traicionera. Las rutas le pasan al helper una
 * conexión por un cast que el type-check no puede desmentir: la de precios pasa
 * el knex de `__pg_connection__` como `PinConn`, y las tres de QuickBooks pasan
 * un `Client` de pg envuelto en `pgAsPinConn`. Si alguno de esos casts está mal
 * en runtime, `verifySupervisorPin` tiene `catch { return false }` — o sea falla
 * CERRADO: no abre un agujero, deja el gate rechazando SIEMPRE. Los cuatro gates
 * estáticos quedan en verde y la rotura aparece en producción.
 *
 * De ahí la asimetría de las aserciones de abajo: un 403 con PIN equivocado NO
 * prueba nada (una conexión rota también da 403). Lo único que prueba que la
 * conexión sirve es que el PIN CORRECTO sea ACEPTADO.
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  1. prices: sin PIN → 403 · PIN equivocado → 403 · PIN correcto → 200 y el
 *     precio REALMENTE cambió en la DB (después se restaura).
 *  2. Las 3 rutas de QB: PIN equivocado → 403 · PIN correcto → NO 403 (avanza y
 *     muere más adelante por datos inexistentes, que es lo que se busca).
 *  3. Límite de intentos: 8 fallos → 403 con `attempts_left` decreciente; el 9º
 *     → 429 SUPERVISOR_PIN_LOCKED.
 *  4. Ninguna respuesta filtra el PIN ni su longitud.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-supervisor-pin-gates-sandbox.ts
 *
 * El PIN se lee de la DB del sandbox en runtime y NUNCA se imprime, ni entero ni
 * parcial: este archivo tiene que poder vivir en el repo sin ser una capa más
 * donde el valor quede escrito.
 */
import { Client } from "pg";

// ── Guards fail-closed ───────────────────────────────────────────────────────
// El test hace 8+ intentos fallidos de PIN a propósito, lo que bloquea al usuario
// 15 minutos. Contra prod eso sería un DoS de las autorizaciones de la tienda, y
// el snapshot del sandbox trae los MISMOS user ids que prod. Así que el destino
// no se infiere: se exige.
const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(
    `BASE apunta a ${BASE}. Este script SOLO corre contra el backend sandbox en ` +
      `localhost:9099 — hace fallar el PIN 8 veces y eso bloquea al usuario 15 min.`
  );
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(
    `la DB no es la del sandbox (se esperaba localhost:5499). Leer el PIN de la ` +
      `DB equivocada, o peor escribirle un precio, es exactamente lo que este ` +
      `guard impide.`
  );
}

// ── Mini framework de aserciones ─────────────────────────────────────────────
interface Result {
  ok: boolean;
  name: string;
  detail: string;
}
const results: Result[] = [];

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
  opts: {
    token: string;
    body?: Record<string, unknown>;
    pin?: string;
    method?: string;
  }
): Promise<Resp> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };
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

/** Un PIN equivocado que jamás pueda coincidir con el real, sea cual sea. */
function wrongPinFor(real: string): string {
  const candidate = "0".repeat(Math.max(real.length, 4));
  return candidate === real ? "1".repeat(candidate.length) : candidate;
}

async function main(): Promise<void> {
  console.log("=== e2e-supervisor-pin-gates (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  // ── PIN real (nunca se imprime) ────────────────────────────────────────────
  const { rows: storeRows } = await db.query<{ pin: string | null }>(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
      WHERE metadata->>'pos_supervisor_pin' IS NOT NULL ORDER BY id LIMIT 1`
  );
  const realPin = storeRows[0]?.pin;
  if (!realPin) {
    await db.end();
    abort(
      `el store del sandbox no tiene pos_supervisor_pin. Configurarlo por ` +
        `POST /admin/pos/supervisor-pin antes de correr esto.`
    );
  }
  const badPin = wrongPinFor(realPin);
  console.log(`  · PIN del sandbox: presente (${realPin.length} dígitos, no se imprime)\n`);

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

  // ── Ítem de prueba ─────────────────────────────────────────────────────────
  const { rows: itemRows } = await db.query<{
    product_id: string;
    variant_id: string;
    price_id: string;
    amount: string;
  }>(
    `SELECT pv.product_id, pvps.variant_id, pr.id AS price_id, pr.amount
       FROM product_variant_price_set pvps
       JOIN product_variant pv ON pv.id = pvps.variant_id AND pv.deleted_at IS NULL
       JOIN price pr ON pr.price_set_id = pvps.price_set_id
         AND pr.currency_code='usd' AND pr.price_list_id IS NULL AND pr.deleted_at IS NULL
      WHERE pvps.deleted_at IS NULL AND pr.amount > 0
      ORDER BY pr.amount ASC LIMIT 1`
  );
  const item = itemRows[0];
  if (!item) {
    await db.end();
    abort("no se encontró ninguna variante con precio base USD en el sandbox.");
  }
  const originalAmount = Number(item.amount);

  async function currentAmount(): Promise<number> {
    const { rows } = await db.query<{ amount: string }>(
      `SELECT amount FROM price WHERE id = $1`,
      [item.price_id]
    );
    return Number(rows[0]?.amount);
  }

  // ═══ 1 · prices ═══════════════════════════════════════════════════════════
  console.log("1 · pos/prices/[productId]");
  const priceBody = {
    retail_price: 42.42,
    wholesale_price: 21.21,
    variant_id: item.variant_id,
  };
  const pricePath = `/admin/pos/prices/${item.product_id}`;

  const noPin = await call(pricePath, { token, body: priceBody });
  check(
    "sin PIN → 403",
    noPin.status === 403 && noPin.body.code === "INVALID_SUPERVISOR_PIN",
    `dio ${noPin.status} ${noPin.raw.slice(0, 160)}`
  );
  check(
    "sin PIN no escribió el precio",
    (await currentAmount()) === originalAmount,
    `el precio cambió a ${await currentAmount()} pese al 403`
  );

  const wrong = await call(pricePath, { token, body: priceBody, pin: badPin });
  check(
    "PIN equivocado → 403",
    wrong.status === 403 && wrong.body.code === "INVALID_SUPERVISOR_PIN",
    `dio ${wrong.status} ${wrong.raw.slice(0, 160)}`
  );

  // LA aserción que importa: con la conexión mal casteada esto daría 403 también.
  const good = await call(pricePath, { token, body: priceBody, pin: realPin });
  check(
    "PIN correcto → 200 (prueba que el cast de knex a PinConn sirve)",
    good.status === 200,
    `dio ${good.status} ${good.raw.slice(0, 200)}`
  );
  const afterWrite = await currentAmount();
  check(
    "el precio SÍ se escribió",
    afterWrite === 42.42,
    `se esperaba 42.42 y quedó ${afterWrite}`
  );

  // Restaurar (el sandbox es desechable, pero un test que deja basura se vuelve
  // difícil de correr dos veces seguidas y sus fallos dejan de ser legibles).
  await db.query(
    `UPDATE price SET amount = $1,
        raw_amount = jsonb_build_object('value', $2::text, 'precision', 20)
      WHERE id = $3`,
    [originalAmount, String(originalAmount), item.price_id]
  );
  check(
    "precio restaurado",
    (await currentAmount()) === originalAmount,
    "no se pudo restaurar el precio original"
  );

  // ═══ 2 · las 3 rutas de QuickBooks ════════════════════════════════════════
  // Cuerpos con FORMA válida (pasan la validación de 400) pero ids inexistentes:
  // así la request llega al guard, y con el PIN correcto lo atraviesa y muere
  // más adelante por datos que no existen. Ese "más adelante" es la prueba.
  console.log("\n2 · rutas de QuickBooks (guard + pgAsPinConn)");
  const qbRoutes: { name: string; path: string; body: Record<string, unknown> }[] = [
    {
      name: "bill-match/adopt",
      path: "/admin/quickbooks/bill-match/adopt",
      body: { po_id: "po_e2e_inexistente", txn_id: "txn_e2e_inexistente", mode: "adopted" },
    },
    {
      name: "bill-match/undo",
      path: "/admin/quickbooks/bill-match/undo",
      body: { vendor_bill_id: "vb_e2e_inexistente" },
    },
    {
      name: "customer-credits/import",
      path: "/admin/quickbooks/customer-credits/import",
      body: { customer_id: "cus_e2e_inexistente", txn_id: "txn_e2e_inexistente", doc_type: "credit_memo" },
    },
  ];

  for (const r of qbRoutes) {
    const bad = await call(r.path, { token, body: r.body, pin: badPin });
    check(
      `${r.name}: PIN equivocado → 403`,
      bad.status === 403 && bad.body.code === "INVALID_SUPERVISOR_PIN",
      `dio ${bad.status} ${bad.raw.slice(0, 160)}`
    );

    const ok = await call(r.path, { token, body: r.body, pin: realPin });
    check(
      `${r.name}: PIN correcto ATRAVIESA el guard (prueba pgAsPinConn)`,
      ok.status !== 403,
      `siguió dando 403 con el PIN correcto → la conexión del helper no sirve ` +
        `y el gate rechaza siempre: ${ok.raw.slice(0, 200)}`
    );
  }

  // ═══ 3 · límite de intentos ═══════════════════════════════════════════════
  // Va ÚLTIMO a propósito: al bloquear al usuario, todo lo que venga después
  // recibiría 429 y fallaría por una razón que no es la suya.
  console.log("\n3 · límite de intentos (bloquea al usuario — corre al final)");
  const MAX = 8;
  let lastAttemptsLeft: number | null = null;
  let sawDecreasing = true;
  for (let i = 1; i <= MAX; i++) {
    const r = await call(pricePath, { token, body: priceBody, pin: badPin });
    const left = typeof r.body.attempts_left === "number" ? r.body.attempts_left : null;
    if (r.status !== 403) {
      check(`intento ${i} de ${MAX} → 403`, false, `dio ${r.status}`);
      sawDecreasing = false;
      break;
    }
    if (lastAttemptsLeft !== null && left !== null && left >= lastAttemptsLeft) {
      sawDecreasing = false;
    }
    lastAttemptsLeft = left;
  }
  check(
    `${MAX} intentos fallidos devuelven 403 con attempts_left decreciente`,
    sawDecreasing && lastAttemptsLeft === 0,
    `attempts_left terminó en ${lastAttemptsLeft} (se esperaba 0) o no decreció`
  );

  const locked = await call(pricePath, { token, body: priceBody, pin: badPin });
  check(
    "el intento siguiente → 429 SUPERVISOR_PIN_LOCKED",
    locked.status === 429 && locked.body.code === "SUPERVISOR_PIN_LOCKED",
    `dio ${locked.status} ${locked.raw.slice(0, 160)}`
  );

  // Con el usuario bloqueado, el PIN CORRECTO también se rechaza — y se rechaza
  // ANTES de comparar, que es lo que impide sondear el bloqueo por tiempo.
  const lockedGood = await call(pricePath, { token, body: priceBody, pin: realPin });
  check(
    "bloqueado, el PIN correcto también se rechaza (no se compara)",
    lockedGood.status === 429,
    `dio ${lockedGood.status} — el bloqueo no cubre al PIN válido`
  );
  check(
    "el precio no se movió durante toda la tanda de bloqueo",
    (await currentAmount()) === originalAmount,
    "una request bloqueada llegó a escribir"
  );

  // ═══ 4 · ninguna respuesta filtra el PIN ══════════════════════════════════
  console.log("\n4 · no-filtración");
  const everything = [noPin, wrong, good, locked, lockedGood]
    .map((r) => r.raw)
    .join(" ");
  check(
    "ninguna respuesta contiene el PIN",
    !everything.includes(realPin),
    "una respuesta trae el valor del PIN"
  );
  check(
    "ningún mensaje revela la longitud esperada",
    !/\b\d+\s*(d[ií]gitos|digits|characters|caracteres)\b/i.test(everything),
    "un mensaje dice cuántos dígitos tiene el PIN"
  );

  await db.end();

  // ── Resumen ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length === 0 ? "✅" : "❌"} ${results.length - failed.length}/${results.length} aserciones OK`
  );
  if (failed.length > 0) {
    console.log("\nFallos:");
    for (const f of failed) console.log(`  • ${f.name}: ${f.detail}`);
  }
  console.log(
    `\nNota: el usuario ${email} queda BLOQUEADO ~15 min en el sandbox (esperado).\n` +
      `Para desbloquearlo ya: docker exec sb_redis redis-cli --scan --pattern '*supervisor-pin*' | xargs -r docker exec -i sb_redis redis-cli DEL`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`\n❌ el E2E explotó: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
