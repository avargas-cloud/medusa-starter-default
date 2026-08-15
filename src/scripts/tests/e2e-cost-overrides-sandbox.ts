/**
 * E2E de las rutas delta de cost overrides — SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El PriceCalcModal guardaba `cost_overrides` mandando el objeto COMPLETO al
 * POST nativo del documento: dos saves in-flight se pisaban (el segundo no
 * llevaba la clave del primero y el replace del server la borraba) mientras el
 * UI decía "guardado". Las rutas nuevas aplican deltas {set, remove} en UN
 * UPDATE atómico de JSONB. Este test prueba la ATOMICIDAD contra el Postgres
 * real del sandbox — un unit test con mocks no puede probar un row-lock.
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  1. Dos saves CONCURRENTES sobre claves distintas → ambas quedan (la carrera
 *     que el flujo viejo perdía).
 *  2. remove borra la clave y preserva las demás + el resto del metadata.
 *  3. Anclaje de recurso: la ruta de orders 404ea un draft y viceversa
 *     (la clase de bug documentType).
 *  4. Payloads inválidos → 400 sin tocar nada.
 *  5. Cleanup: las claves de test se remueven y el metadata queda como estaba.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-cost-overrides-sandbox.ts
 */
import { Client } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(`BASE apunta a ${BASE}. Este script SOLO corre contra el sandbox :9099 — escribe metadata de órdenes.`);
}
if (!/localhost:5499|127\.0\.0\.1:5499/.test(SB_DB)) {
  abort(`SB_DB apunta a ${SB_DB.replace(/:[^@]*@/, ":***@")} — sólo el Postgres sandbox :5499.`);
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

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
    abort(`no se pudo loguear como ${email} (HTTP ${authRes.status}). Ver docs/SANDBOX.md.`);
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.token}`,
  };

  // ── Fixtures: una orden real y un draft, de la DB del sandbox ─────────────
  const pick = async (isDraft: boolean) => {
    const { rows } = await db.query<{ id: string; metadata: Record<string, unknown> | null }>(
      `SELECT id, metadata FROM "order"
        WHERE deleted_at IS NULL AND is_draft_order = $1
        ORDER BY created_at DESC LIMIT 1`,
      [isDraft]
    );
    if (!rows.length) abort(`el sandbox no tiene ${isDraft ? "drafts" : "órdenes"}`);
    return rows[0];
  };
  const order = await pick(false);
  const draft = await pick(true);
  console.log(`\n  · orden ${order.id} · draft ${draft.id}\n`);

  const K1 = "e2e_test_key_1";
  const K2 = "e2e_test_key_2";
  const post = (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  const readOverrides = async (id: string): Promise<Record<string, number>> => {
    const { rows } = await db.query<{ ov: Record<string, number> | null }>(
      `SELECT metadata->'cost_overrides' AS ov FROM "order" WHERE id = $1`,
      [id]
    );
    return rows[0]?.ov ?? {};
  };

  for (const [label, doc, path, wrongPath] of [
    ["ORDER", order, `/admin/orders/${order.id}/cost-overrides`, `/admin/draft-orders/${order.id}/cost-overrides`],
    ["DRAFT", draft, `/admin/draft-orders/${draft.id}/cost-overrides`, `/admin/orders/${draft.id}/cost-overrides`],
  ] as const) {
    console.log(`━━ ${label} ${doc.id}`);
    const metaBefore = doc.metadata ?? {};
    const overridesBefore = (metaBefore.cost_overrides as Record<string, number> | undefined) ?? {};

    // 1. Dos saves CONCURRENTES sobre claves distintas — la carrera del flujo viejo.
    const [r1, r2] = await Promise.all([
      post(path, { set: { [K1]: 1.11 } }),
      post(path, { set: { [K2]: 2.2222 } }),
    ]);
    check("ambos POSTs concurrentes responden 200", r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`);
    const afterConcurrent = await readOverrides(doc.id);
    check("las DOS claves quedaron (ninguna se pisó)", afterConcurrent[K1] === 1.11 && afterConcurrent[K2] === 2.2222,
      JSON.stringify({ [K1]: afterConcurrent[K1], [K2]: afterConcurrent[K2] }));

    // 2. remove borra una y preserva la otra + los overrides preexistentes.
    const r3 = await post(path, { remove: [K1] });
    const body3 = (await r3.json().catch(() => ({}))) as { cost_overrides?: Record<string, number> };
    const afterRemove = await readOverrides(doc.id);
    check("remove borra la clave y responde el canónico", r3.status === 200 && afterRemove[K1] === undefined && body3.cost_overrides?.[K1] === undefined);
    check("la otra clave y los overrides previos sobreviven",
      afterRemove[K2] === 2.2222 && Object.entries(overridesBefore).every(([k, v]) => afterRemove[k] === v));

    // 3. El resto del metadata quedó intacto (control negativo).
    const { rows: metaRows } = await db.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM "order" WHERE id = $1`, [doc.id]
    );
    const metaAfter = metaRows[0].metadata ?? {};
    const otherKeysIntact = Object.keys(metaBefore)
      .filter((k) => k !== "cost_overrides")
      .every((k) => JSON.stringify(metaAfter[k]) === JSON.stringify(metaBefore[k]));
    check("las demás claves del metadata no se tocaron", otherKeysIntact);

    // 4. Anclaje de recurso: la ruta equivocada 404ea sin escribir.
    const r4 = await post(wrongPath, { set: { e2e_wrong_route: 9.99 } });
    const afterWrong = await readOverrides(doc.id);
    check("la ruta del recurso equivocado da 404 y no escribe", r4.status === 404 && afterWrong.e2e_wrong_route === undefined, `HTTP ${r4.status}`);

    // 5. Payloads inválidos → 400.
    const invalids: unknown[] = [
      {},
      { set: { [K1]: 0 } },
      { set: { [K1]: -3 } },
      { set: { "": 1 } },
      { remove: "no-array" },
      { set: { [K1]: 1 }, remove: [K1] },
      { extra_field: true, set: { [K1]: 1 } },
    ];
    let all400 = true;
    for (const bad of invalids) {
      const r = await post(path, bad);
      if (r.status !== 400) { all400 = false; check("payload inválido rechazado con 400", false, `HTTP ${r.status} para ${JSON.stringify(bad)}`); }
    }
    if (all400) check("los 7 payloads inválidos dan 400", true);

    // 6. Cleanup: sacar la clave restante y verificar estado original.
    await post(path, { remove: [K2] });
    const afterCleanup = await readOverrides(doc.id);
    check("cleanup: overrides vuelven al estado original",
      JSON.stringify(afterCleanup) === JSON.stringify(overridesBefore),
      JSON.stringify(afterCleanup));
    console.log("");
  }

  await db.end();
  if (failures > 0) {
    console.error(`\n❌ ${failures} aserciones fallaron\n`);
    process.exit(1);
  }
  console.log("✅ cost-overrides delta: todas las aserciones pasaron\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
