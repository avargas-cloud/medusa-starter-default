/**
 * e2e-void-estimate-sandbox.ts
 *
 * E2E del `POST /admin/draft-orders/:id/void` — el botón Void de un estimate en
 * el POS. Contra el SANDBOX.
 *
 * POR QUÉ EXISTE
 *   El 2026-08-20 ese route se refactorizó para delegar en el chokepoint
 *   `lib/draft-orders/cancel-draft-order.ts`, compartido con la supersesión de
 *   convert-force. La lógica se preservó y el gate estático asserta su forma,
 *   pero la TRADUCCIÓN A HTTP —que es lo que cambió— no la ejercitaba nada. Y si
 *   esa traducción quedara mal, el síntoma no es un badge rojo: es que el botón
 *   Void deja de funcionar y se entera un operador, tarde.
 *
 * EL 409 DE FULFILLMENTS NO SE PRUEBA ACÁ, Y ES A PROPÓSITO
 *   Un draft order no llega a tener fulfillments: medido contra el sandbox
 *   (restore de producción), 0 de 0. Fabricar uno a mano probaría una situación
 *   que el sistema no produce. Que el mapeo a 409 sigue existiendo lo asserta
 *   `verify-superseded-draft-cleanup.ts` (check 2c). Esta es una limitación
 *   declarada, no un olvido.
 *
 * CORRER (backend sandbox arriba en 9099):
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-void-estimate-sandbox.ts
 */
import { Client } from "pg";

const API = process.env.MEDUSA_SANDBOX_URL ?? "http://localhost:9099";
const PG =
  process.env.SANDBOX_PG ?? "postgresql://postgres:sandbox@localhost:5499/medusa";
const ADMIN_EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "sandbox@test.com";
const ADMIN_PASS = process.env.SANDBOX_ADMIN_PASSWORD ?? "sandbox123";

const POS_CHANNEL = "sc_15154EAF0D194265ADD21AAD2D";
const REGION = "reg_01KFS28SNF1MT1MRHRAFQ6ZGK1";
const CUSTOMER = "cus_01KJ3WJ48J5PJY5C8MARHWFBE9";
const VARIANT = "variant_adorne-20a-tamper-resistant-self-test-gfci-outlet_10167";

// Este archivo ANULA documentos. Un typo en la URL no puede hacer eso en prod.
for (const [label, url] of [["API", API], ["PG", PG]] as const) {
  const host = new URL(url.replace(/^postgres(ql)?:/, "http:")).hostname;
  if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    console.error(`RECHAZADO: ${label}="${host}" no es el sandbox.`);
    process.exit(2);
  }
}

let token = "";
async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, body: json };
}

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail?: string) =>
  checks.push({ name, ok: !!cond, detail });

/**
 * `qty` existe por una razón que costó una corrida en rojo: el estimate que este
 * archivo CONVIERTE tenía siempre el mismo contenido, así que dos corridas
 * seguidas caían dentro de la ventana de 45s del guard anti-duplicado de
 * convert-force — el segundo se detectaba como duplicado del primero y la
 * supersesión lo cancelaba, con toda la razón. El assert 3c lo leía como "el
 * void canceló de más" y daba rojo intermitente. La flakiness era el feature
 * funcionando; el fixture es el que tenía que ser único.
 */
async function makeEstimate(tag: string, qty = 1): Promise<string> {
  const r = await api("/admin/draft-orders", {
    method: "POST",
    body: {
      customer_id: CUSTOMER,
      sales_channel_id: POS_CHANNEL,
      region_id: REGION,
      items: [{ variant_id: VARIANT, quantity: qty, unit_price: 38.25 }],
      metadata: { pos_created: true, e2e_void_tag: tag },
    },
  });
  const id = r.body?.draft_order?.id;
  if (!id)
    throw new Error(
      `no se pudo crear el estimate: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`
    );
  return id;
}

async function row(db: Client, id: string) {
  const r = await db.query(
    `SELECT status, is_draft_order, canceled_at, metadata FROM "order" WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`INFRA CAÍDA: ${API} no responde. Este run no prueba nada.`);
    process.exit(3);
  }
  const auth = await fetch(`${API}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  }).then((r) => r.json());
  token = auth.token;
  if (!token) throw new Error(`login falló: ${JSON.stringify(auth)}`);

  const db = new Client({ connectionString: PG });
  await db.connect();

  try {
    const tag = `void-${Date.now()}`;
    const target = await makeEstimate(tag);
    // Hermano intacto: si el void cancelara de más, este lo denuncia.
    const bystander = await makeEstimate(tag);

    // ── CONTROL POSITIVO del estado inicial ────────────────────────────────
    // Sin esto, "quedó cancelado" podría estar midiendo algo que ya venía así.
    const before = await row(db, target);
    ok(
      "0 · CONTROL POSITIVO: el estimate arranca VIVO y como draft",
      before?.status !== "canceled" &&
        before?.canceled_at === null &&
        before?.is_draft_order === true,
      `status=${before?.status} canceled_at=${before?.canceled_at} is_draft=${before?.is_draft_order}`
    );

    // ── 1 · El happy path ──────────────────────────────────────────────────
    const v = await api(`/admin/draft-orders/${target}/void`, { method: "POST" });
    ok("1a · el void responde 200", v.status === 200, `status=${v.status}`);
    ok("1b · y reporta éxito", v.body?.success === true, JSON.stringify(v.body).slice(0, 160));
    ok(
      "1c · reconoce que no hay estimate en QB que desactivar",
      v.body?.qbSkipped === true,
      `qbSkipped=${v.body?.qbSkipped}`
    );

    const after = await row(db, target);
    ok(
      "1d · EL EFECTO: la orden quedó cancelada en la base",
      after?.status === "canceled" && after?.canceled_at !== null,
      `status=${after?.status} canceled_at=${after?.canceled_at}`
    );
    ok(
      "1e · con order_status='Voided' estampado",
      after?.metadata?.order_status === "Voided",
      `order_status=${after?.metadata?.order_status}`
    );
    ok(
      "1f · y qb_sync_status='voided' (no 'voiding': no hay QB que esperar)",
      after?.metadata?.qb_sync_status === "voided",
      `qb_sync_status=${after?.metadata?.qb_sync_status}`
    );

    // ── 2 · ASSERT NEGATIVA: no tocó al hermano ────────────────────────────
    const other = await row(db, bystander);
    ok(
      "2a · ASSERT NEGATIVA: el otro estimate sigue vivo e intacto",
      other?.status !== "canceled" &&
        other?.canceled_at === null &&
        other?.metadata?.order_status !== "Voided",
      `status=${other?.status} order_status=${other?.metadata?.order_status}`
    );

    // ── 3 · Los rechazos que el POS muestra al operador ─────────────────────
    const twice = await api(`/admin/draft-orders/${target}/void`, { method: "POST" });
    ok(
      "3a · anular dos veces devuelve 422, no 500",
      twice.status === 422,
      `status=${twice.status} body=${JSON.stringify(twice.body).slice(0, 120)}`
    );

    // Una orden real (ya convertida) no se anula por este endpoint.
    // Cantidad ÚNICA por corrida: ver la nota en makeEstimate — con contenido
    // repetido, dos corridas seguidas chocan contra el guard de 45s.
    const uniqueQty = 2 + (Date.now() % 97);
    const converted = await makeEstimate(`${tag}-conv`, uniqueQty);
    await api(`/admin/draft-orders/${converted}/convert-force`, { method: "POST" });
    const notDraft = await api(`/admin/draft-orders/${converted}/void`, { method: "POST" });
    ok(
      "3b · una orden ya convertida se rechaza con 422",
      notDraft.status === 422,
      `status=${notDraft.status} body=${JSON.stringify(notDraft.body).slice(0, 120)}`
    );
    const convRow = await row(db, converted);
    ok(
      "3c · ASSERT NEGATIVA: y ese rechazo NO la canceló",
      convRow?.status !== "canceled",
      `status=${convRow?.status}`
    );

    const missing = await api(`/admin/draft-orders/order_NO_EXISTE_E2E/void`, {
      method: "POST",
    });
    ok(
      "3d · un id inexistente devuelve 404",
      missing.status === 404,
      `status=${missing.status}`
    );

    // ── Limpieza acotada: sólo lo que marcó ESTE archivo ────────────────────
    await db.query(
      `UPDATE "order" SET canceled_at = NOW()
        WHERE canceled_at IS NULL AND metadata->>'e2e_void_tag' IS NOT NULL`
    );
  } finally {
    await db.end();
  }

  const bad = checks.filter((c) => !c.ok);
  for (const c of checks) {
    console.log(`  ${c.ok ? "ok " : "NO "} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${checks.length - bad.length}/${checks.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
