/**
 * e2e-superseded-draft-cleanup-sandbox.ts
 *
 * E2E de la limpieza del draft PERDEDOR de un doble submit, contra el SANDBOX.
 *
 * QUÉ PRUEBA QUE EL GATE ESTÁTICO NO PUEDE
 *   `verify-superseded-draft-cleanup.ts` afirma la FORMA del código: que la
 *   llamada existe, que está guardada, que el orden de sentencias hace la falla
 *   abierta. Nada de eso prueba que la cancelación ocurra de verdad contra
 *   Postgres, ni que el ganador sobreviva. Eso se prueba acá.
 *
 * CONTROLES (sin ellos esto pasaría en vacío)
 *   · POSITIVO del bug: antes del fix el perdedor quedaba `draft` y vivo. El
 *     assert es que ahora queda `canceled` Y linkeado al ganador — dos hechos,
 *     no uno: cancelado sin linkear pierde la trazabilidad.
 *   · NEGATIVO: un convert NORMAL (sin duplicado) no cancela nada. Sin este, un
 *     bug que cancele todo draft convertido pasaría verde.
 *   · NEGATIVO: la orden GANADORA sigue viva y no-draft al final.
 *   · ASSERT NEGATIVA: el perdedor no tenía reservas y sigue sin tenerlas — la
 *     limpieza no puede tocar stock.
 *
 * CORRER (el backend sandbox tiene que estar arriba en 9099):
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-superseded-draft-cleanup-sandbox.ts
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

// Este archivo CONVIERTE órdenes y CANCELA drafts. Un typo en la URL no puede
// terminar haciendo eso en producción.
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

async function makeDraft(db: Client, tag: string): Promise<string> {
  const r = await api("/admin/draft-orders", {
    method: "POST",
    body: {
      customer_id: CUSTOMER,
      sales_channel_id: POS_CHANNEL,
      region_id: REGION,
      items: [{ variant_id: VARIANT, quantity: 1, unit_price: 38.25 }],
      metadata: { pos_created: true, e2e_supersede_tag: tag },
    },
  });
  const id = r.body?.draft_order?.id;
  if (!id) throw new Error(`no se pudo crear el draft: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return id;
}

async function row(db: Client, id: string) {
  const r = await db.query(
    `SELECT status, is_draft_order, canceled_at, metadata FROM "order" WHERE id = $1`,
    [id]
  );
  return r.rows[0];
}

async function reservationCount(db: Client, orderId: string): Promise<number> {
  const r = await db.query(
    `SELECT count(*)::int n FROM reservation_item ri
       JOIN order_line_item oli ON oli.id = ri.line_item_id
       JOIN order_item oi ON oi.item_id = oli.id
      WHERE oi.order_id = $1`,
    [orderId]
  );
  return r.rows[0]?.n ?? 0;
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
    // ── Caso 1 · doble submit: el perdedor queda cancelado y linkeado ───────
    const tag = `sup-${Date.now()}`;
    const winnerDraft = await makeDraft(db, tag);
    const loserDraft = await makeDraft(db, tag);

    const loserReservationsBefore = await reservationCount(db, loserDraft);

    const w = await api(`/admin/draft-orders/${winnerDraft}/convert-force`, { method: "POST" });
    ok("1a · el primer convert crea la orden ganadora", w.status === 200 && !w.body?.deduplicated,
      `status=${w.status} dedup=${w.body?.deduplicated}`);

    const l = await api(`/admin/draft-orders/${loserDraft}/convert-force`, { method: "POST" });
    ok("1b · el segundo convert se detecta como duplicado", l.body?.deduplicated === true,
      `dedup=${l.body?.deduplicated}`);
    ok("1c · y devuelve la orden GANADORA (la caja no se traba)", l.body?.order?.id === winnerDraft,
      `devolvió=${l.body?.order?.id} esperado=${winnerDraft}`);

    const loser = await row(db, loserDraft);
    ok("1d · el draft perdedor quedó CANCELADO (antes quedaba vivo — es E3132)",
      loser?.status === "canceled" && loser?.canceled_at !== null,
      `status=${loser?.status} canceled_at=${loser?.canceled_at}`);
    ok("1e · y linkeado al ganador (cancelar sin linkear pierde la trazabilidad)",
      loser?.metadata?.superseded_by_order_id === winnerDraft,
      `superseded_by=${loser?.metadata?.superseded_by_order_id}`);
    ok("1f · con motivo y fecha, para auditoría",
      loser?.metadata?.superseded_reason === "duplicate_submit" && !!loser?.metadata?.superseded_at,
      `reason=${loser?.metadata?.superseded_reason} at=${loser?.metadata?.superseded_at}`);

    const winner = await row(db, winnerDraft);
    ok("1g · CONTROL NEGATIVO: la orden ganadora sigue viva y no es draft",
      winner?.status !== "canceled" && winner?.is_draft_order === false,
      `status=${winner?.status} is_draft=${winner?.is_draft_order}`);

    const loserReservationsAfter = await reservationCount(db, loserDraft);
    ok("1h · ASSERT NEGATIVA: la limpieza no tocó stock (0 reservas antes y después)",
      loserReservationsBefore === 0 && loserReservationsAfter === 0,
      `antes=${loserReservationsBefore} después=${loserReservationsAfter}`);

    // ── Caso 2 · CONTROL NEGATIVO: un convert normal no cancela nada ────────
    // Sin esto, un bug que cancelara TODO draft convertido pasaría verde arriba.
    const soloDraft = await makeDraft(db, `${tag}-solo`);
    // Contenido distinto para no caer en el fingerprint del caso 1.
    await api(`/admin/draft-orders/${soloDraft}/add-item-force`, {
      method: "POST",
      body: { variant_id: VARIANT, quantity: 7, unit_price: 11.11, custom_title: "solo" },
    });
    const s = await api(`/admin/draft-orders/${soloDraft}/convert-force`, { method: "POST" });
    const solo = await row(db, soloDraft);
    ok("2a · un convert sin duplicado NO se marca como deduplicado", !s.body?.deduplicated,
      `dedup=${s.body?.deduplicated}`);
    ok("2b · CONTROL NEGATIVO: y su orden NO queda cancelada",
      solo?.status !== "canceled" && !solo?.metadata?.superseded_by_order_id,
      `status=${solo?.status} superseded_by=${solo?.metadata?.superseded_by_order_id}`);

    // ── Caso 3 · idempotencia: repetir el convert del perdedor no rompe ─────
    const again = await api(`/admin/draft-orders/${loserDraft}/convert-force`, { method: "POST" });
    ok("3a · repetir el convert del perdedor no devuelve 5xx", again.status < 500,
      `status=${again.status}`);
    const loserAgain = await row(db, loserDraft);
    ok("3b · y lo deja igual (cancelado, mismo ganador)",
      loserAgain?.status === "canceled" &&
        loserAgain?.metadata?.superseded_by_order_id === winnerDraft,
      `status=${loserAgain?.status} superseded_by=${loserAgain?.metadata?.superseded_by_order_id}`);

    // ── Limpieza acotada: sólo lo que marcó ESTE archivo ────────────────────
    await db.query(
      `UPDATE "order" SET canceled_at = NOW()
        WHERE canceled_at IS NULL AND metadata->>'e2e_supersede_tag' IS NOT NULL`
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
